'use strict';

/**
 * Integration tests for the `check predicate` subcommand wiring (#2008).
 *
 * These exercise the PRODUCTION stack: the real `buildPredicateDeps()` binding
 * (which wraps shell-command-projection.execTool → bounded `sh -c` spawnSync) and
 * the `parsePredicateFlags` arg parser. The pure evaluator logic is covered by
 * gate-predicate-evaluator.test.cjs; this file proves the wiring holds against
 * real subprocess exit codes and a real timeout kill.
 *
 * Commands run are instant (`true` / `false` / `exit 3`) or tightly bounded
 * (a 100ms timeout killing `sleep 1`), so there is no orphan/leak risk.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluatePredicate } = require('../gsd-core/bin/lib/gate-predicate-evaluator.cjs');
const { buildPredicateDeps, parsePredicateFlags } = require('../gsd-core/bin/lib/check-command-router.cjs');

// ─── buildPredicateDeps: real subprocess exit mapping ─────────────────────────

describe('buildPredicateDeps — real bounded sh -c subprocess', () => {
  const deps = buildPredicateDeps();
  const cwd = process.cwd();

  test('`true` => exitCode 0, not timed out', () => {
    const r = deps.runBoundedShell({ command: 'true', cwd, timeoutMs: 5000 });
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
  });

  test('`false` => exitCode 1, not timed out', () => {
    const r = deps.runBoundedShell({ command: 'false', cwd, timeoutMs: 5000 });
    assert.equal(r.exitCode, 1);
    assert.equal(r.timedOut, false);
  });

  test('`exit 3` => exitCode 3', () => {
    const r = deps.runBoundedShell({ command: 'exit 3', cwd, timeoutMs: 5000 });
    assert.equal(r.exitCode, 3);
  });

  test('stderr is captured from the subprocess', () => {
    const r = deps.runBoundedShell({ command: 'echo oops >&2; exit 4', cwd, timeoutMs: 5000 });
    assert.equal(r.exitCode, 4);
    assert.match(r.stderr, /oops/);
  });

  test('timeout kills the subprocess (SIGTERM => timedOut:true)', () => {
    const r = deps.runBoundedShell({ command: 'sleep 1', cwd, timeoutMs: 100 });
    assert.equal(r.timedOut, true);
    assert.equal(r.signal, 'SIGTERM');
  });
});

// ─── evaluatePredicate + production deps: end-to-end exit mapping ─────────────

describe('evaluatePredicate + production deps — command-exit-zero e2e', () => {
  const deps = buildPredicateDeps();
  const ctx = { cwd: process.cwd() };

  test('command `true` => block:false', () => {
    const res = evaluatePredicate({ kind: 'command-exit-zero', command: 'true' }, ctx, deps);
    assert.equal(res.block, false);
  });

  test('command `false` => block:true', () => {
    const res = evaluatePredicate({ kind: 'command-exit-zero', command: 'false' }, ctx, deps);
    assert.equal(res.block, true);
    assert.match(res.message, /1/);
  });

  test('interpolation reaches the real shell ($PHASE_NUMBER via flag context)', () => {
    const res = evaluatePredicate(
      { kind: 'command-exit-zero', command: 'test "${PHASE_NUMBER}" = "07" && true || false' },
      { cwd: process.cwd(), phaseNumber: '07' },
      deps,
    );
    assert.equal(res.block, false);
  });
});

// ─── parsePredicateFlags ───────────────────────────────────────────────────────

describe('parsePredicateFlags', () => {
  test('extracts --flag value pairs, skips positional + bare --flags', () => {
    const out = parsePredicateFlags(['check', 'predicate', '--predicate', '{"kind":"x"}', '--phase-number', '03', '--raw']);
    assert.deepEqual(out, { predicate: '{"kind":"x"}', 'phase-number': '03' });
  });

  test('last write wins for repeated flags', () => {
    const out = parsePredicateFlags(['--phase-number', '01', '--phase-number', '02']);
    assert.equal(out['phase-number'], '02');
  });

  test('value that starts with -- is not consumed (treated as a flag)', () => {
    const out = parsePredicateFlags(['--predicate', '--phase-number']);
    assert.equal('predicate' in out, false);
  });

  test('empty args => empty map', () => {
    assert.deepEqual(parsePredicateFlags([]), {});
  });
});
