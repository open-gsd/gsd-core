'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// parseConfigDirArg is not exported directly from bin/install.js (it closes
// over the module-level `args` array).  We expose a pure seam here:
// parseConfigDirFromArgs(args) that mirrors the function's logic so we can
// test the equals-form parsing without spawning a child process.
//
// The implementation under test is inlined below (RED: before the fix it will
// reproduce the truncation bug).  Once the fix lands, we swap in the real
// implementation via require.

/**
 * Pure seam that replicates the equals-form parse logic from bin/install.js.
 * We import it via a thin wrapper so that the function can be tested without
 * executing the entire install script.
 *
 * During RED the bug is: `split('=')[1]` drops everything after the second `=`.
 */
const { parseConfigDirFromArgs } = require('../bin/install.js');

describe('bug-442: --config-dir= equals-form path parsing', () => {
  // ── Happy-path: single = in path ─────────────────────────────────────────
  test('--config-dir=<path> with one = in value returns full value', () => {
    const result = parseConfigDirFromArgs(['--config-dir=/tmp/gsd=a']);
    assert.equal(result, '/tmp/gsd=a');
  });

  // ── Happy-path: multiple = in path ───────────────────────────────────────
  test('--config-dir=<path> with multiple = in value returns full value', () => {
    const result = parseConfigDirFromArgs(['--config-dir=/tmp/a=b=c']);
    assert.equal(result, '/tmp/a=b=c');
  });

  // ── Short form -c= ────────────────────────────────────────────────────────
  test('-c=<path> with = in value returns full value', () => {
    const result = parseConfigDirFromArgs(['-c=/tmp/gsd=a']);
    assert.equal(result, '/tmp/gsd=a');
  });

  test('-c=<path> with multiple = in value returns full value', () => {
    const result = parseConfigDirFromArgs(['-c=/tmp/a=b=c']);
    assert.equal(result, '/tmp/a=b=c');
  });

  // ── Contract: empty value ─────────────────────────────────────────────────
  // --config-dir= (no value after the =) → returns empty string ''.
  // The caller (parseConfigDirArg) treats '' as missing and errors; the seam
  // itself should faithfully return '' rather than null/undefined so the
  // caller can make the error decision.
  test('--config-dir= with no value returns empty string', () => {
    const result = parseConfigDirFromArgs(['--config-dir=']);
    assert.equal(result, '');
  });

  test('-c= with no value returns empty string', () => {
    const result = parseConfigDirFromArgs(['-c=']);
    assert.equal(result, '');
  });

  // ── Space-separated form is unaffected (regression guard) ─────────────────
  test('--config-dir <path> space-separated still returns the path', () => {
    const result = parseConfigDirFromArgs(['--config-dir', '/tmp/gsd=a']);
    assert.equal(result, '/tmp/gsd=a');
  });

  test('-c <path> space-separated still returns the path', () => {
    const result = parseConfigDirFromArgs(['-c', '/tmp/gsd=a']);
    assert.equal(result, '/tmp/gsd=a');
  });

  // ── No config-dir flag → null ─────────────────────────────────────────────
  test('returns null when no --config-dir flag is present', () => {
    const result = parseConfigDirFromArgs(['--global', '--claude']);
    assert.equal(result, null);
  });

  // ── Negative matrix (CLI edge cases) ─────────────────────────────────────
  // Flag-looking value after space form: next arg starts with - → null (no
  // valid value; the real function would process.exit but the seam returns null
  // so tests stay in-process).
  test('space form with next arg being a flag returns null (flag-looking value)', () => {
    const result = parseConfigDirFromArgs(['--config-dir', '--other-flag']);
    assert.equal(result, null);
  });

  // Equals form where value is a path with no = (plain path, no regression)
  test('--config-dir=<plain-path> without any = in path still works', () => {
    const result = parseConfigDirFromArgs(['--config-dir=/tmp/plain']);
    assert.equal(result, '/tmp/plain');
  });

  // Flag appears after other args (positional ordering should not matter)
  test('--config-dir= flag after other args is parsed correctly', () => {
    const result = parseConfigDirFromArgs(['--global', '--config-dir=/tmp/a=b', '--claude']);
    assert.equal(result, '/tmp/a=b');
  });
});
