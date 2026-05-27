'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNamedArgs,
  parseMultiwordArg,
} = require('../get-shit-done/bin/lib/command-arg-projection.cjs');

// ---------------------------------------------------------------------------
// parseNamedArgs — behavior-lock tests (green before AND after the #312 fix)
// ---------------------------------------------------------------------------

test('value flag with valid value', () => {
  assert.deepStrictEqual(
    parseNamedArgs(['--name', 'foo'], ['name']),
    { name: 'foo' }
  );
});

test('value flag followed by another flag (value rejected)', () => {
  assert.deepStrictEqual(
    parseNamedArgs(['--name', '--other'], ['name']),
    { name: null }
  );
});

test('value flag at end of array (no following token)', () => {
  assert.deepStrictEqual(
    parseNamedArgs(['--name'], ['name']),
    { name: null }
  );
});

test('value flag absent from args', () => {
  assert.deepStrictEqual(
    parseNamedArgs(['--x', 'y'], ['name']),
    { name: null }
  );
});

test('boolean flag present', () => {
  assert.deepStrictEqual(
    parseNamedArgs(['--write'], [], ['write']),
    { write: true }
  );
});

test('boolean flag absent', () => {
  assert.deepStrictEqual(
    parseNamedArgs([], [], ['write']),
    { write: false }
  );
});

test('first-occurrence-wins: duplicate value flag uses first index', () => {
  // Locks the indexOf-first semantics that the Map must preserve (#312)
  assert.deepStrictEqual(
    parseNamedArgs(['--name', 'a', '--name', 'b'], ['name']),
    { name: 'a' }
  );
});

test('mixed multiple flags (the O(flags*argv) case)', () => {
  assert.deepStrictEqual(
    parseNamedArgs(['--a', '1', '--flag', '--b', '2'], ['a', 'b'], ['flag']),
    { a: '1', b: '2', flag: true }
  );
});

test('empty args with multiple declared flags', () => {
  assert.deepStrictEqual(
    parseNamedArgs([], ['name', 'path'], ['verbose', 'dry-run']),
    { name: null, path: null, verbose: false, 'dry-run': false }
  );
});

test('value flag value undefined via array boundary', () => {
  // --count is last token; args[idx+1] is undefined — must return null
  assert.deepStrictEqual(
    parseNamedArgs(['--other', 'x', '--count'], ['count']),
    { count: null }
  );
});

test('boolean flag does not clobber an already-set value-flag key when names differ', () => {
  assert.deepStrictEqual(
    parseNamedArgs(['--msg', 'hello', '--verbose'], ['msg'], ['verbose']),
    { msg: 'hello', verbose: true }
  );
});

// ---------------------------------------------------------------------------
// parseMultiwordArg — spot coverage for module completeness
// ---------------------------------------------------------------------------

test('parseMultiwordArg: collects tokens until next flag', () => {
  assert.strictEqual(
    parseMultiwordArg(['--msg', 'hello', 'world', '--x'], 'msg'),
    'hello world'
  );
});

test('parseMultiwordArg: absent flag returns null', () => {
  assert.strictEqual(
    parseMultiwordArg(['--other', 'val'], 'msg'),
    null
  );
});

test('parseMultiwordArg: flag present but no tokens returns null', () => {
  assert.strictEqual(
    parseMultiwordArg(['--msg', '--next'], 'msg'),
    null
  );
});

test('parseMultiwordArg: flag at end of array with no tokens returns null', () => {
  assert.strictEqual(
    parseMultiwordArg(['--msg'], 'msg'),
    null
  );
});
