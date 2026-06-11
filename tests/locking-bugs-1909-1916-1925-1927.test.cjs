// allow-test-rule: architectural-invariant
// state.cjs locking must use Atomics.wait() (not a spin-loop) and register an exit
// handler. These are implementation primitives, not string literals — behavioral tests
// cannot verify which sleep primitive was chosen. Source inspection is the right level.

/**
 * Regression tests for locking bugs #1909, #1916, #1925, #1927.
 *
 * These tests are written FIRST (TDD) — they must fail before the fixes are applied
 * and pass after.
 *
 * #1909 — CPU-burning busy-wait in acquireStateLock
 * #1916 — Lock files persist after process.exit()
 * #1925 — TOCTOU races in 8 state commands (read outside lock)
 * #1927 — config.json has no locking in setConfigValue
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { runGsdTools, createTempProject, cleanup, waitFor, TOOLS_PATH } = require('./helpers.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function writeStateMd(tmpDir, content) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    content,
    'utf-8'
  );
}

function readStateMd(tmpDir) {
  return fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
}

function writeConfig(tmpDir, obj) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf-8');
}

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// #1909 source-grep (Atomics.wait) deleted per #453 (clock-seam):
// the deterministic replacement in tests/clock-seam.test.cjs
// describe('acquireStateLock clock seam') proves the seam accepts and calls
// clock.sleep() without inspecting source text.

// ─────────────────────────────────────────────────────────────────────────────
// #1916 — Lock files persist after process.exit()
// Verify that the STATE.md.lock file is removed even when process.exit() is called
// while the lock is held (e.g., via error() inside a locked region).
// ─────────────────────────────────────────────────────────────────────────────

describe('#1916 lock cleanup on process.exit()', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('STATE.md.lock is removed after a command exits with an error', () => {
    // Intentionally trigger an error path: state update with missing STATE.md leaves
    // no lock behind (the read-before-lock path returns gracefully, but let's verify
    // a command that holds the lock can't accidentally leave the file).
    writeStateMd(tmpDir, [
      '# Project State',
      '',
      '**Status:** Planning',
      '**Current Phase:** 01',
    ].join('\n') + '\n');

    // Run a state update — even if it fails, the lock must not remain
    runGsdTools('state update Status "In progress"', tmpDir);

    const lockPath = path.join(tmpDir, '.planning', 'STATE.md.lock');
    assert.ok(
      !fs.existsSync(lockPath),
      'STATE.md.lock must not persist after any state command terminates'
    );
  });

  // #1916 source-grep tests (process.on('exit') in state.cjs and planning-workspace.cjs)
  // deleted per #453 (clock-seam). Deterministic replacement in tests/clock-seam.test.cjs:
  //   describe('exit cleanup: STATE.md.lock removed on process exit')
  //   describe('exit cleanup: .planning/.lock removed on process exit')
  // Both exercise the real exit path without inspecting source text.
});

// ─────────────────────────────────────────────────────────────────────────────
// #1925 — TOCTOU races in 8 state commands
// Each of the 8 commands reads STATE.md outside the lock, then calls writeStateMd
// (which only locks the write). Two concurrent callers reading the same content
// means the second write clobbers the first.
//
// Fix: migrate all 8 to use readModifyWriteStateMd().
// Test: call the same command twice concurrently on SEPARATE fields and verify
// both updates survive.
// ─────────────────────────────────────────────────────────────────────────────

describe('#1925 TOCTOU: state commands use readModifyWriteStateMd', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('state update: both concurrent updates to different fields survive', async () => {
    // Deterministic concurrency via file-barrier synchronization.
    //
    // Problem with the prior design: Promise.all([execAsync(A), execAsync(B)])
    // offers no guarantee that both subprocesses are alive simultaneously.  On a
    // loaded CI runner one subprocess can fully complete (acquire lock → transform
    // → release lock → exit) before the other's Node runtime has even started.
    // When that happens the second subprocess never contends on the lock — the
    // test trivially passes — but the test also fails to exercise what it claims
    // to test.  On Docker overlay-fs under load the opposite pathology occurs:
    // both subprocesses race O_EXCL creation, and depending on scheduler timing
    // one can observe stale fs state, causing a lost update that fails the
    // assertion.  Either way, the outcome is non-deterministic.
    //
    // Redesign: a barrier file forces both subprocesses to reach their "ready"
    // gate before either is allowed to proceed.  The barrier is removed only
    // after BOTH have signalled readiness, guaranteeing true overlap in the
    // critical section.  No sleep-based synchronization; the barrier loop uses
    // Atomics.wait (same primitive as acquireStateLock) so it yields the CPU
    // instead of spinning.

    writeStateMd(tmpDir, [
      '# Project State',
      '',
      '**Status:** Planning',
      '**Current Phase:** 01',
      '**Current Plan:** 01-01',
      '**Last Activity:** 2024-01-01',
    ].join('\n') + '\n');

    // ── Barrier infrastructure ────────────────────────────────────────────────
    // barrierPath: exists while subprocesses must hold.  Removed by the test
    //              orchestrator once both subprocesses have signalled readiness.
    // ready-{id}:  each subprocess creates this file to signal it is at the gate.
    const barrierPath = path.join(tmpDir, '.barrier');
    const readyA     = path.join(tmpDir, '.ready-a');
    const readyB     = path.join(tmpDir, '.ready-b');
    fs.writeFileSync(barrierPath, '1');       // erect the barrier
    if (fs.existsSync(readyA)) fs.unlinkSync(readyA);
    if (fs.existsSync(readyB)) fs.unlinkSync(readyB);

    // ── Wrapper script written to tmpDir ─────────────────────────────────────
    // Each subprocess runs this wrapper, which:
    //   1. Writes its ready-signal so the orchestrator knows it is alive.
    //   2. Spins (Atomics.wait, 10 ms steps) until the barrier is removed.
    //   3. Immediately calls gsd-tools to exercise the real lock contention.
    //
    // TOOLS_PATH and the caller-supplied args are injected via env vars to avoid
    // shell-quoting complexity when the tmpDir path contains spaces.
    const wrapperPath = path.join(tmpDir, '.barrier-wrapper-update.cjs');
    fs.writeFileSync(wrapperPath, [
      "'use strict';",
      'const fs   = require("fs");',
      'const path = require("path");',
      'const { execFileSync } = require("child_process");',
      'const { TOOLS_PATH, BARRIER_FILE, READY_FILE, FIELD_NAME, FIELD_VALUE, CWD_PATH } = process.env;',
      '',
      '// Signal readiness to the orchestrator.',
      'fs.writeFileSync(READY_FILE, String(process.pid));',
      '',
      '// Wait at the barrier (yield via Atomics.wait so we do not spin the CPU).',
      '// Budget: 10 s — if the orchestrator never releases us, something is broken.',
      'const sab = new SharedArrayBuffer(4);',
      'const sai = new Int32Array(sab);',
      'const deadline = Date.now() + 10000;',
      'while (fs.existsSync(BARRIER_FILE)) {',
      '  if (Date.now() > deadline) { process.stderr.write("barrier timeout\\n"); process.exit(1); }',
      '  Atomics.wait(sai, 0, 0, 10); // sleep 10 ms, then re-check',
      '}',
      '',
      '// Barrier is down — execute the actual gsd-tools command.',
      'execFileSync(process.execPath, [TOOLS_PATH, "state", "update", FIELD_NAME, FIELD_VALUE, "--cwd", CWD_PATH], {',
      '  stdio: "pipe",',
      '});',
    ].join('\n'));

    const nodeBin = process.execPath;

    // ── Spawn both subprocesses ───────────────────────────────────────────────
    // Both start immediately; both block at the barrier until the orchestrator
    // confirms both are ready, then both proceed to contend on the STATE.md lock.
    const children = [];
    function spawnWrapper(fieldName, fieldValue, readyFile) {
      return new Promise((resolve, reject) => {
        const child = spawn(nodeBin, [wrapperPath], {
          env: {
            ...process.env,
            TOOLS_PATH,
            BARRIER_FILE: barrierPath,
            READY_FILE:   readyFile,
            FIELD_NAME:   fieldName,
            FIELD_VALUE:  fieldValue,
            CWD_PATH:     tmpDir,
          },
          stdio: 'pipe',
        });
        children.push(child);
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) reject(new Error(`wrapper exited ${code}: ${stderr}`));
          else resolve();
        });
      });
    }

    const promiseA = spawnWrapper('Status', 'Executing', readyA);
    const promiseB = spawnWrapper('Current Phase', '02', readyB);

    // ── Orchestrate: wait for both ready-signals, then drop the barrier ───────
    try {
      await waitFor(() => fs.existsSync(readyA) && fs.existsSync(readyB), {
        timeoutMs: 10000,
        stepMs: 10,
        message: 'Timed out waiting for both subprocesses to reach barrier',
      });
      // Both subprocesses are at the gate — drop the barrier simultaneously.
      fs.unlinkSync(barrierPath);

      // ── Collect results ───────────────────────────────────────────────────────
      await Promise.all([promiseA, promiseB]);
    } finally {
      for (const c of children) { try { c.kill(); } catch { /* already exited */ } }
    }

    const content = readStateMd(tmpDir);
    assert.ok(
      content.includes('Executing') && content.includes('02'),
      'Both concurrent state update commands must survive (TOCTOU bug: second write clobbers first).\n' +
      'Content:\n' + content
    );
  });

  // 'state add-decision: both concurrent calls append different decisions' deleted per #453
  // (clock-seam): plain Promise.all without a barrier is non-deterministic — one subprocess
  // can complete before the other starts, so no real lock contention is exercised.
  // The barrier-based 'state add-blocker' test below and the clock-seam call-site coverage
  // tests in tests/clock-seam.test.cjs cover the same append-operation correctness.

  test('state add-blocker: both concurrent calls append different blockers', async () => {
    // Deterministic concurrency via file-barrier synchronization (Option A).
    //
    // Problem with the prior design: Promise.all([execAsync(A), execAsync(B)])
    // offers no guarantee that both subprocesses are alive simultaneously.  On a
    // loaded CI runner one subprocess can fully complete (acquire lock → transform
    // → release lock → exit) before the other's Node runtime has even started.
    // When that happens the second subprocess never contends on the lock — the
    // test trivially passes — but the test also fails to exercise what it claims
    // to test.  On Docker overlay-fs under load the opposite pathology occurs:
    // both subprocesses race O_EXCL creation, and depending on scheduler timing
    // one can observe stale fs state, causing a lost update that fails the
    // assertion.  Either way, the outcome is non-deterministic.
    //
    // Redesign: a barrier file forces both subprocesses to reach their "ready"
    // gate before either is allowed to proceed.  The barrier is removed only
    // after BOTH have signalled readiness, guaranteeing true overlap in the
    // critical section.  No sleep-based synchronization; the barrier loop uses
    // Atomics.wait (same primitive as acquireStateLock) so it yields the CPU
    // instead of spinning.

    writeStateMd(tmpDir, [
      '# Project State',
      '',
      '**Current Phase:** 01',
      '',
      '### Blockers',
      'None.',
    ].join('\n') + '\n');

    // ── Barrier infrastructure ────────────────────────────────────────────────
    // barrierPath: exists while subprocesses must hold.  Removed by the test
    //              orchestrator once both subprocesses have signalled readiness.
    // ready-{id}:  each subprocess creates this file to signal it is at the gate.
    const barrierPath = path.join(tmpDir, '.barrier');
    const readyA     = path.join(tmpDir, '.ready-a');
    const readyB     = path.join(tmpDir, '.ready-b');
    fs.writeFileSync(barrierPath, '1');       // erect the barrier
    if (fs.existsSync(readyA)) fs.unlinkSync(readyA);
    if (fs.existsSync(readyB)) fs.unlinkSync(readyB);

    // ── Wrapper script written to tmpDir ─────────────────────────────────────
    // Each subprocess runs this wrapper, which:
    //   1. Writes its ready-signal so the orchestrator knows it is alive.
    //   2. Spins (Atomics.wait, 10 ms steps) until the barrier is removed.
    //   3. Immediately calls gsd-tools to exercise the real lock contention.
    //
    // TOOLS_PATH and the caller-supplied args are injected via env vars to avoid
    // shell-quoting complexity when the tmpDir path contains spaces.
    const wrapperPath = path.join(tmpDir, '.barrier-wrapper.cjs');
    fs.writeFileSync(wrapperPath, [
      "'use strict';",
      'const fs   = require("fs");',
      'const path = require("path");',
      'const { execFileSync } = require("child_process");',
      'const { TOOLS_PATH, BARRIER_FILE, READY_FILE, BLOCKER_TEXT, CWD_PATH } = process.env;',
      '',
      '// Signal readiness to the orchestrator.',
      'fs.writeFileSync(READY_FILE, String(process.pid));',
      '',
      '// Wait at the barrier (yield via Atomics.wait so we do not spin the CPU).',
      '// Budget: 10 s — if the orchestrator never releases us, something is broken.',
      'const sab = new SharedArrayBuffer(4);',
      'const sai = new Int32Array(sab);',
      'const deadline = Date.now() + 10000;',
      'while (fs.existsSync(BARRIER_FILE)) {',
      '  if (Date.now() > deadline) { process.stderr.write("barrier timeout\\n"); process.exit(1); }',
      '  Atomics.wait(sai, 0, 0, 10); // sleep 10 ms, then re-check',
      '}',
      '',
      '// Barrier is down — execute the actual gsd-tools command.',
      'execFileSync(process.execPath, [TOOLS_PATH, "state", "add-blocker", "--text", BLOCKER_TEXT, "--cwd", CWD_PATH], {',
      '  stdio: "pipe",',
      '});',
    ].join('\n'));

    const nodeBin = process.execPath;

    // ── Spawn both subprocesses ───────────────────────────────────────────────
    // Both start immediately; both block at the barrier until the orchestrator
    // confirms both are ready, then both proceed to contend on the STATE.md lock.
    const children = [];
    function spawnWrapper(blockerId, readyFile) {
      return new Promise((resolve, reject) => {
        const child = spawn(nodeBin, [wrapperPath], {
          env: {
            ...process.env,
            TOOLS_PATH,
            BARRIER_FILE: barrierPath,
            READY_FILE:   readyFile,
            BLOCKER_TEXT: blockerId,
            CWD_PATH:     tmpDir,
          },
          stdio: 'pipe',
        });
        children.push(child);
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) reject(new Error(`wrapper exited ${code}: ${stderr}`));
          else resolve();
        });
      });
    }

    const promiseA = spawnWrapper('Need API credentials',    readyA);
    const promiseB = spawnWrapper('Waiting for design review', readyB);

    // ── Orchestrate: wait for both ready-signals, then drop the barrier ───────
    try {
      await waitFor(() => fs.existsSync(readyA) && fs.existsSync(readyB), {
        timeoutMs: 10000,
        stepMs: 10,
        message: 'Timed out waiting for both subprocesses to reach barrier',
      });
      // Both subprocesses are at the gate — drop the barrier simultaneously.
      fs.unlinkSync(barrierPath);

      // ── Collect results ───────────────────────────────────────────────────────
      await Promise.all([promiseA, promiseB]);
    } finally {
      for (const c of children) { try { c.kill(); } catch { /* already exited */ } }
    }

    const content = readStateMd(tmpDir);
    assert.ok(
      content.includes('Need API credentials') && content.includes('Waiting for design review'),
      'Both concurrent add-blocker calls must survive.\n' +
      'Content:\n' + content
    );
  });

  // 'state commands use readModifyWriteStateMd (source audit)' deleted per #453 (clock-seam):
  // source-grep of cmd* function bodies is brittle. Deterministic replacement in
  // tests/clock-seam.test.cjs describe('readModifyWriteStateMd call-site coverage') exercises
  // each cmd* via CLI and confirms the lock is acquired-and-released (STATE.md.lock absent after
  // command), which is only possible if readModifyWriteStateMd's finally block ran.
});

// ─────────────────────────────────────────────────────────────────────────────
// #1927 — config.json has no locking in setConfigValue
// setConfigValue does read-modify-write on config.json without holding any lock.
// Fix: wrap in withPlanningLock.
// ─────────────────────────────────────────────────────────────────────────────

describe('#1927 config.json: setConfigValue must hold planning lock', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('both concurrent config-set calls persist their values', async () => {
    // Deterministic concurrency via file-barrier synchronization (mirrors the
    // locking-bugs:180 and :235 redesigns).
    //
    // The old Promise.all([execAsync(A), execAsync(B)]) design is non-deterministic:
    // on a loaded Docker runner one subprocess can complete before the other has
    // even started, meaning there is no real lock contention — or the opposite:
    // both race O_EXCL and one observes stale fs state, causing a lost write that
    // fails the assertion.  A barrier file forces both to be alive simultaneously
    // before either runs the actual config-set.
    writeConfig(tmpDir, {
      model_profile: 'balanced',
      workflow: {
        research: true,
        plan_check: true,
      },
    });

    // ── Barrier infrastructure ────────────────────────────────────────────────
    const barrierPath = path.join(tmpDir, '.barrier-1927');
    const readyA     = path.join(tmpDir, '.ready-1927-a');
    const readyB     = path.join(tmpDir, '.ready-1927-b');
    fs.writeFileSync(barrierPath, '1');
    if (fs.existsSync(readyA)) fs.unlinkSync(readyA);
    if (fs.existsSync(readyB)) fs.unlinkSync(readyB);

    // ── Wrapper script ────────────────────────────────────────────────────────
    const wrapperPath = path.join(tmpDir, '.barrier-wrapper-config-set.cjs');
    fs.writeFileSync(wrapperPath, [
      "'use strict';",
      'const fs   = require("fs");',
      'const { execFileSync } = require("child_process");',
      'const { TOOLS_PATH, BARRIER_FILE, READY_FILE, CONFIG_KEY, CONFIG_VAL, CWD_PATH } = process.env;',
      '',
      'fs.writeFileSync(READY_FILE, String(process.pid));',
      '',
      'const sab = new SharedArrayBuffer(4);',
      'const sai = new Int32Array(sab);',
      'const deadline = Date.now() + 10000;',
      'while (fs.existsSync(BARRIER_FILE)) {',
      '  if (Date.now() > deadline) { process.stderr.write("barrier timeout\\n"); process.exit(1); }',
      '  Atomics.wait(sai, 0, 0, 10);',
      '}',
      '',
      'execFileSync(process.execPath, [TOOLS_PATH, "config-set", CONFIG_KEY, CONFIG_VAL, "--cwd", CWD_PATH], {',
      '  stdio: "pipe",',
      '});',
    ].join('\n'));

    const nodeBin = process.execPath;

    const children = [];
    function spawnWrapper(configKey, configVal, readyFile) {
      return new Promise((resolve, reject) => {
        const child = spawn(nodeBin, [wrapperPath], {
          env: {
            ...process.env,
            TOOLS_PATH,
            BARRIER_FILE: barrierPath,
            READY_FILE:   readyFile,
            CONFIG_KEY:   configKey,
            CONFIG_VAL:   configVal,
            CWD_PATH:     tmpDir,
          },
          stdio: 'pipe',
        });
        children.push(child);
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) reject(new Error(`wrapper exited ${code}: ${stderr}`));
          else resolve();
        });
      });
    }

    const promiseA = spawnWrapper('model_profile', 'quality', readyA);
    const promiseB = spawnWrapper('workflow.research', 'false', readyB);

    // ── Wait for both to reach barrier, then release ──────────────────────────
    try {
      await waitFor(() => fs.existsSync(readyA) && fs.existsSync(readyB), {
        timeoutMs: 10000,
        stepMs: 10,
        message: 'Timed out waiting for both config-set subprocesses to reach barrier',
      });
      fs.unlinkSync(barrierPath);

      await Promise.all([promiseA, promiseB]);
    } finally {
      for (const c of children) { try { c.kill(); } catch { /* already exited */ } }
    }

    const config = readConfig(tmpDir);
    assert.strictEqual(
      config.model_profile,
      'quality',
      'config-set model_profile must survive concurrent write'
    );
    assert.strictEqual(
      config.workflow?.research,
      false,
      'config-set workflow.research must survive concurrent write'
    );
  });

  // 'config.cjs setConfigValue uses withPlanningLock (source audit)' deleted per #453 (clock-seam):
  // source-grep is brittle. The barrier-based 'both concurrent config-set calls persist their values'
  // test above already proves withPlanningLock is in effect (both values survive the concurrent writes).
});
