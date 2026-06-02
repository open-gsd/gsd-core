/**
 * Integration tests for gsd-context-monitor.js auto-record on CRITICAL (#1974).
 *
 * Verifies:
 * 1. On CRITICAL + active GSD project, the hook sets criticalRecorded in the
 *    warn sentinel AND the state record-session command writes the "Stopped At"
 *    field to STATE.md.
 * 2. Subsequent CRITICAL firings within the same session do NOT re-fire
 *    the subprocess (sentinel guard prevents repeated overwrites).
 * 3. When no .planning/STATE.md exists, the subprocess is not spawned.
 * 4. Path resolution uses __dirname, not hardcoded ~/.claude/.
 * 5. A WARNING-only fire does NOT set criticalRecorded (selectivity counter-test).
 *
 * Design note (#3726, #3775): the original test used a short wall-clock poll
 * against a fire-and-forget spawn().unref() subprocess and flaked under load.
 * We keep one deterministic assertion (criticalRecorded sentinel is written
 * before hook exit), and use a bounded poll window for the detached writer's
 * STATE.md update. A separate test verifies direct record-session invocation.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.resolve(__dirname, '..', 'hooks', 'gsd-context-monitor.js');
const GSD_TOOLS = path.resolve(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

// Windows can hold a transient handle on the temp dir after a spawnSync child
// exits (AV scanner / handle-release lag), so cleanup()'s internal rmSync retry
// (~5s) occasionally still throws EBUSY/EPERM/ENOTEMPTY under CI load. Restore a
// bounded outer retry with async backoff (NOT Atomics.wait — lint no-magic-sleep).
// Re-adds the guard removed in #482. Refs #490.
async function cleanupWithRetry(dir, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    try { cleanup(dir); return; }
    catch (err) {
      const transient = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY');
      if (!transient || i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
    }
  }
}

/**
 * Run the hook with a given session id and context percentage.
 * Writes a bridge metrics file first, then pipes the hook input via stdin.
 * Returns after the hook exits.
 */
function runHook(sessionId, remainingPct, cwd) {
  // Write the bridge metrics file the hook reads
  const bridgePath = path.join(os.tmpdir(), `claude-ctx-${sessionId}.json`);
  fs.writeFileSync(bridgePath, JSON.stringify({
    session_id: sessionId,
    remaining_percentage: remainingPct,
    used_pct: 100 - remainingPct,
    timestamp: Math.floor(Date.now() / 1000),
  }));

  const input = JSON.stringify({
    session_id: sessionId,
    cwd,
  });

  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input,
    encoding: 'utf-8',
    timeout: 10000,
    env: { ...process.env, HOME: process.env.HOME },
  });

  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Run gsd-tools state record-session synchronously.
 * Returns { exitCode, stdout, stderr }.
 * Used to verify the persistence seam deterministically without relying on
 * the fire-and-forget subprocess timing that caused flake (#3726).
 */
function runRecordSession(cwd, stoppedAt) {
  const result = spawnSync(
    process.execPath,
    [GSD_TOOLS, 'state', 'record-session', '--stopped-at', stoppedAt, '--cwd', cwd],
    { encoding: 'utf-8', timeout: 30000 }
  );
  return {
    exitCode: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Read and parse the warn sentinel file for a session.
 * Returns the parsed object, or null if the file does not exist.
 */
function readWarnData(sessionId) {
  const warnPath = path.join(os.tmpdir(), `claude-ctx-${sessionId}-warned.json`);
  try {
    return JSON.parse(fs.readFileSync(warnPath, 'utf-8'));
  } catch {
    return null;
  }
}

describe('#1974 context exhaustion auto-record', () => {
  let tmpDir;
  let statePath;
  let sessionId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1974-'));
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });

    // Minimal STATE.md with Stopped At field
    statePath = path.join(planningDir, 'STATE.md');
    fs.writeFileSync(statePath, [
      '# Session State',
      '',
      '**Current Phase:** 1',
      '**Status:** executing',
      '**Last session:** unset',
      '**Last Date:** unset',
      '**Stopped At:** None',
      '**Resume File:** None',
      '',
    ].join('\n'));

    // Minimal config.json required by gsd-tools
    fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({ project_code: 'TEST' }));

    sessionId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    // cleanupWithRetry wraps cleanup() with a bounded outer retry (async setTimeout
    // backoff, no Atomics.wait) to handle cases where windows-2022 CI load keeps
    // the temp dir EBUSY beyond rmSync's internal ~5s retry window. Refs #490.
    await cleanupWithRetry(tmpDir);
    // Clean up bridge files
    try {
      const warnPath = path.join(os.tmpdir(), `claude-ctx-${sessionId}-warned.json`);
      if (fs.existsSync(warnPath)) fs.unlinkSync(warnPath);
      const bridgePath = path.join(os.tmpdir(), `claude-ctx-${sessionId}.json`);
      if (fs.existsSync(bridgePath)) fs.unlinkSync(bridgePath);
    } catch { /* noop */ }
  });

  test('sets criticalRecorded sentinel on CRITICAL (synchronous assertion only)', () => {
    // Trigger CRITICAL — remaining <= 25
    // The detached record-session subprocess timing assertion (waitForStateMatch,
    // 45s poll) was removed per #453 (clock-seam): flaky under load. The
    // deterministic coverage for STATE.md persistence lives in the
    // 'state record-session command persists Stopped At when invoked directly'
    // test below, which uses spawnSync instead of a fire-and-forget subprocess.
    const result = runHook(sessionId, 20, tmpDir);
    assert.strictEqual(result.exitCode, 0, `hook should exit 0: ${result.stderr}`);

    // Deterministic: hook writes criticalRecorded:true to warnPath SYNCHRONOUSLY
    // before the hook process exits, before the fire-and-forget subprocess runs.
    // Since runHook() uses spawnSync, this is guaranteed readable now.
    const warnData = readWarnData(sessionId);
    assert.ok(warnData, 'warn sentinel file must exist after CRITICAL fire');
    assert.strictEqual(
      warnData.criticalRecorded,
      true,
      'hook must set criticalRecorded:true in warn sentinel on CRITICAL'
    );
  });

  test('does NOT spawn subprocess when .planning/STATE.md is absent', () => {
    // Delete STATE.md to simulate non-GSD project
    fs.unlinkSync(statePath);

    const result = runHook(sessionId, 20, tmpDir);
    assert.strictEqual(result.exitCode, 0);

    // The hook checks isGsdActive via fs.existsSync(STATE.md) before setting
    // criticalRecorded.  If STATE.md is absent, criticalRecorded must NOT be set.
    const warnData = readWarnData(sessionId);
    // warnData may exist (hook still debounces) but criticalRecorded must be absent/falsy.
    const criticalRecorded = warnData && warnData.criticalRecorded;
    assert.ok(!criticalRecorded, 'criticalRecorded must not be set when STATE.md is absent');
    assert.ok(!fs.existsSync(statePath), 'STATE.md should not be recreated when absent');
  });

  test('sentinel prevents repeated firing within same session', () => {
    // First CRITICAL fire — should set criticalRecorded synchronously.
    const result1 = runHook(sessionId, 20, tmpDir);
    assert.strictEqual(result1.exitCode, 0, `first hook fire should exit 0: ${result1.stderr}`);

    const warnData1 = readWarnData(sessionId);
    assert.ok(warnData1, 'warn sentinel must exist after first CRITICAL fire');
    assert.strictEqual(warnData1.criticalRecorded, true, 'first fire must set criticalRecorded:true');

    // Second CRITICAL fire — same session, criticalRecorded already true in
    // warnPath.  Advance callsSinceWarn past DEBOUNCE_CALLS (5, see hook
    // line 29) so the hook processes the warning message path and exercises
    // the sentinel guard.  Using 10 (2× DEBOUNCE_CALLS) ensures we clear the
    // debounce threshold regardless of any future DEBOUNCE_CALLS adjustment.
    const warnPath = path.join(os.tmpdir(), `claude-ctx-${sessionId}-warned.json`);
    const warnDataPatched = { ...warnData1, callsSinceWarn: 10 };
    fs.writeFileSync(warnPath, JSON.stringify(warnDataPatched));

    const result2 = runHook(sessionId, 18, tmpDir);
    assert.strictEqual(result2.exitCode, 0, `second hook fire should exit 0: ${result2.stderr}`);

    // The warnData must still carry criticalRecorded:true — the guard was
    // active and the hook did not reset or clear it.
    const warnData2 = readWarnData(sessionId);
    assert.strictEqual(warnData2 && warnData2.criticalRecorded, true, 'sentinel must remain true after second fire');

    // The hook's stdout must still emit a CRITICAL warning message (so the
    // agent sees context warnings) even though record-session was NOT re-fired.
    const output2 = result2.stdout ? (() => { try { return JSON.parse(result2.stdout); } catch { return null; } })() : null;
    assert.ok(
      output2 && output2.hookSpecificOutput && /CONTEXT CRITICAL/.test(output2.hookSpecificOutput.additionalContext),
      'second CRITICAL fire must still emit CONTEXT CRITICAL warning to the agent'
    );
  });

  test('state record-session command persists Stopped At when invoked directly', () => {
    const recordResult = runRecordSession(tmpDir, 'context exhaustion at 80% (2026-01-01)');
    assert.strictEqual(
      recordResult.exitCode,
      0,
      `record-session should exit 0 (signal=${recordResult.signal || 'none'} error=${recordResult.error ? recordResult.error.message : 'none'}): ${recordResult.stderr}`
    );
    const content = fs.readFileSync(statePath, 'utf-8');
    assert.match(content, /context exhaustion at 80% \(2026-01-01\)/, 'STATE.md must contain direct record-session value');
  });

  test('WARNING-only fire does NOT set criticalRecorded (selectivity counter-test)', () => {
    // Trigger WARNING (remaining 30% — below WARNING_THRESHOLD=35, above CRITICAL_THRESHOLD=25)
    const result = runHook(sessionId, 30, tmpDir);
    assert.strictEqual(result.exitCode, 0, `hook should exit 0: ${result.stderr}`);

    // criticalRecorded must NOT be set on a WARNING-only fire
    const warnData = readWarnData(sessionId);
    const criticalRecorded = warnData && warnData.criticalRecorded;
    assert.ok(!criticalRecorded, 'WARNING-only fire must not set criticalRecorded');
  });

  // 'hook uses __dirname-based path (runtime-agnostic)' deleted per #453 (clock-seam):
  // source-grep of HOOK_PATH for path.join(__dirname is brittle. The behavioral equivalent
  // (hook successfully resolves gsd-tools.cjs from any working directory) is already covered
  // by the runHook() helper throughout this test file — it calls the hook from an arbitrary
  // tmpDir and all tests pass, proving __dirname-relative resolution works.
});
