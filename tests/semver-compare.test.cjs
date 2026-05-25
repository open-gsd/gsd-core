/**
 * Shared semver compare utility tests.
 *
 * These assertions lock the normalization policy used by update-check,
 * statusline dev-install detection, and changeset extraction range compare.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  compareSemverCore,
  isSemverNewer,
  toNumericTuple,
} = require('../get-shit-done/bin/lib/semver-compare.cjs');

describe('isSemverNewer (shared semver comparison)', () => {
  test('newer major version', () => {
    assert.strictEqual(isSemverNewer('2.0.0', '1.0.0'), true);
  });

  test('newer minor version', () => {
    assert.strictEqual(isSemverNewer('1.1.0', '1.0.0'), true);
  });

  test('newer patch version', () => {
    assert.strictEqual(isSemverNewer('1.0.1', '1.0.0'), true);
  });

  test('equal versions', () => {
    assert.strictEqual(isSemverNewer('1.0.0', '1.0.0'), false);
  });

  test('older version returns false', () => {
    assert.strictEqual(isSemverNewer('1.0.0', '2.0.0'), false);
  });

  test('installed ahead of npm (git install scenario)', () => {
    assert.strictEqual(isSemverNewer('1.30.0', '1.31.0'), false);
  });

  test('npm ahead of installed (real update available)', () => {
    assert.strictEqual(isSemverNewer('1.31.0', '1.30.0'), true);
  });

  test('pre-release suffix stripped', () => {
    assert.strictEqual(isSemverNewer('1.0.1-beta.1', '1.0.0'), true);
  });

  test('pre-release on both sides', () => {
    assert.strictEqual(isSemverNewer('2.0.0-rc.1', '1.9.0-beta.2'), true);
  });

  test('null/undefined handled', () => {
    assert.strictEqual(isSemverNewer(null, '1.0.0'), false);
    assert.strictEqual(isSemverNewer('1.0.0', null), true);
    assert.strictEqual(isSemverNewer(null, null), false);
  });

  test('empty string handled', () => {
    assert.strictEqual(isSemverNewer('', '1.0.0'), false);
    assert.strictEqual(isSemverNewer('1.0.0', ''), true);
  });

  test('two-segment version (missing patch)', () => {
    assert.strictEqual(isSemverNewer('1.1', '1.0'), true);
    assert.strictEqual(isSemverNewer('1.0', '1.1'), false);
  });

  test('v-prefixed versions normalize consistently', () => {
    assert.strictEqual(isSemverNewer('v1.2.1', '1.2.0'), true);
    assert.strictEqual(isSemverNewer('1.2.0', 'v1.2.0'), false);
    assert.deepStrictEqual(toNumericTuple('v1.2.3-rc.1'), [1, 2, 3]);
  });

  test('core comparator uses three-way ordering', () => {
    assert.strictEqual(compareSemverCore('1.2.0', '1.2.0'), 0);
    assert.strictEqual(compareSemverCore('1.2.1', '1.2.0'), 1);
    assert.strictEqual(compareSemverCore('1.2.0', '1.2.1'), -1);
  });
});
