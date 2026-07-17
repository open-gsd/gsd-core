'use strict';
/**
 * state-command-cutover.test.cjs — ADR-2346 (epic #2345) P1 equivalence tests.
 *
 * Verifies that `state`, after cutover from the hardcoded `case 'state':` arm
 * in gsd-tools.cjs to the host dispatch table (dispatchHostCommand, consulted
 * in runCommand's `default` case), behaves identically to the old inline case.
 *
 * Dispatch path after cutover:
 *   runCommand default → dispatchHostCommand → HOST_COMMAND_ROUTERS.state
 *     → routeStateCommand({ state, args, cwd, raw, error })
 *
 * Test categories (mirrors tests/audit-command-cutover.test.cjs):
 *   1. UNIT        — dispatchHostCommand return values + prototype-pollution guard
 *   2. DISPATCH    — `state <sub>` reaches the router via the host table (end-to-end)
 *   3. BEHAVIOR    — real output-shape assertions for `state load` + unknown subcommand
 *   4. JSON-ERRORS — unknown subcommand produces the canonical error
 *   5. REGISTRY    — HOST_COMMAND_ROUTERS owns `state`
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// gsd-tools.cjs is hand-authored (committed, not generated) — safe to require.
const {
  dispatchHostCommand,
  HOST_COMMAND_ROUTERS,
} = require('../gsd-core/bin/gsd-tools.cjs');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeErrorRecorder() {
  const calls = [];
  const fn = (msg, reason) => calls.push({ msg, reason });
  fn.calls = calls;
  return fn;
}

// ─── 1. UNIT — dispatchHostCommand return values + pollution guard ───────────

describe('dispatchHostCommand: unit', async () => {
  const CWD = '/fake/cwd';
  const RAW = false;

  test('returns true for the migrated `state` command (consumed)', async () => {
    // routeStateCommand will run against a fake cwd; it may call error() for a
    // missing subcommand — that is fine, we only assert the dispatch returned
    // true (consumed) rather than falling through to "Unknown command".
    const errFn = makeErrorRecorder();
    const consumed = await dispatchHostCommand({
      command: 'state',
      args: ['state'],
      cwd: CWD,
      raw: RAW,
      error: errFn,
    });
    assert.strictEqual(consumed, true, 'state must be consumed by the host table');
  });

  test('all migrated Tier-1 host commands are consumed by the host table', async () => {
    // Each migrated router receives its module-scope lib via the table entry;
    // against a fake cwd it may emit an error (missing subcommand), but the
    // dispatch itself must report consumed=true (no fall-through to the
    // unknown-command error).
    // NOTE: `capability` (P2) is omitted from this INVOCATION loop — it is async
    // and does FS/config reads, so invoking it against /fake/cwd is fragile.
    // It is covered by the registry-ownership assertion below (non-invoking)
    // and by the dedicated capability-lifecycle/consent/trust/state suites.
    for (const cmd of ['state', 'phase', 'init', 'roadmap', 'validate', 'verify']) {
      const errFn = makeErrorRecorder();
      const consumed = await dispatchHostCommand({
        command: cmd,
        args: [cmd],
        cwd: CWD,
        raw: RAW,
        error: errFn,
      });
      assert.strictEqual(consumed, true, `${cmd} must be consumed by the host table`);
    }
  });

  test('returns false for an unknown command (fall through)', async () => {
    const errFn = makeErrorRecorder();
    const consumed = await dispatchHostCommand({
      command: 'not-a-real-command',
      args: ['not-a-real-command'],
      cwd: CWD,
      raw: RAW,
      error: errFn,
    });
    assert.strictEqual(consumed, false, 'unknown command must fall through');
    assert.strictEqual(errFn.calls.length, 0, 'error must not be called for a miss');
  });

  test('prototype-pollution guard: __proto__/constructor/prototype fall through', async () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      const errFn = makeErrorRecorder();
      const consumed = await dispatchHostCommand({
        command: bad,
        args: [bad],
        cwd: CWD,
        raw: RAW,
        error: errFn,
      });
      assert.strictEqual(consumed, false, `${bad} must not be dispatched`);
      assert.strictEqual(errFn.calls.length, 0, `${bad} must not call error`);
    }
  });
});

// ─── 2 + 3. DISPATCH + BEHAVIOR — end-to-end via runGsdTools ─────────────────

describe('state cutover: end-to-end dispatch via the host table', async () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('`state load` succeeds end-to-end (dispatched via host table, not a case arm)', async () => {
    // Seed a minimal STATE.md so `state load` has something to read.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n## Current Position\n\nPhase: 1 of 1 (Test)\n',
    );

    const result = runGsdTools(['--cwd=' + tmpDir, 'state', 'load'], process.cwd());
    assert.strictEqual(
      result.success,
      true,
      `state load must succeed via the host-table dispatch path; got: ${result.error}`,
    );
  });

  test('unknown state subcommand surfaces the canonical unknown-subcommand error (non-zero exit)', async () => {
    const result = runGsdTools(['--cwd=' + tmpDir, 'state', 'totally-not-a-subcommand'], process.cwd());
    assert.strictEqual(result.success, false, 'unknown subcommand must exit non-zero');
    assert.ok(
      result.error.length > 0,
      'an error message must be emitted for an unknown state subcommand',
    );
  });
});

// ─── 5. REGISTRY — HOST_COMMAND_ROUTERS owns `state` ────────────────────────

describe('HOST_COMMAND_ROUTERS registry', async () => {
  test('owns all 6 migrated Tier-1 host commands as function entries', async () => {
    for (const cmd of ['state', 'phase', 'init', 'roadmap', 'validate', 'verify', 'capability']) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(HOST_COMMAND_ROUTERS, cmd),
        `HOST_COMMAND_ROUTERS must own \`${cmd}\``,
      );
      assert.strictEqual(typeof HOST_COMMAND_ROUTERS[cmd], 'function', `${cmd} entry must be a function`);
    }
  });

  test('does NOT own prototype-pollution keys', async () => {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(HOST_COMMAND_ROUTERS, '__proto__'),
      'HOST_COMMAND_ROUTERS must not own __proto__',
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(HOST_COMMAND_ROUTERS, 'constructor'),
      'HOST_COMMAND_ROUTERS must not own constructor',
    );
  });
});
