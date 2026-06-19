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
  semverSatisfies,
} = require('../gsd-core/bin/lib/semver-compare.cjs');

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

describe('semverSatisfies (ADR-1244 engines.gsd range gate)', () => {
  const sat = (v, r, expected) =>
    assert.strictEqual(semverSatisfies(v, r), expected, `expected satisfies(${JSON.stringify(v)}, ${JSON.stringify(r)}) === ${expected}`);

  test('>= comparator', () => {
    sat('1.6.0', '>=1.6.0', true);
    sat('1.6.1', '>=1.6.0', true);
    sat('2.0.0', '>=1.6.0', true);
    sat('1.5.9', '>=1.6.0', false);
  });

  test('> < <= = comparators', () => {
    sat('1.6.1', '>1.6.0', true);
    sat('1.6.0', '>1.6.0', false);
    sat('1.5.0', '<1.6.0', true);
    sat('1.6.0', '<1.6.0', false);
    sat('1.6.0', '<=1.6.0', true);
    sat('1.6.1', '<=1.6.0', false);
    sat('1.6.0', '=1.6.0', true);
    sat('1.6.1', '=1.6.0', false);
  });

  test('bare exact full version', () => {
    sat('1.6.0', '1.6.0', true);
    sat('1.6.1', '1.6.0', false);
  });

  test('AND-composed range (whitespace)', () => {
    sat('1.6.0', '>=1.6.0 <3.0.0', true);
    sat('2.9.9', '>=1.6.0 <3.0.0', true);
    sat('3.0.0', '>=1.6.0 <3.0.0', false);
    sat('1.5.0', '>=1.6.0 <3.0.0', false);
  });

  test('OR-composed range (||)', () => {
    sat('1.6.0', '>=1.6.0 || >=2.0.0', true);
    sat('2.0.0', '<1.0.0 || >=2.0.0', true);
    sat('1.5.0', '<1.0.0 || >=2.0.0', false);
  });

  test('caret ranges', () => {
    sat('1.2.3', '^1.2.3', true);
    sat('1.9.0', '^1.2.3', true);
    sat('2.0.0', '^1.2.3', false);
    sat('1.2.2', '^1.2.3', false);
    sat('0.2.3', '^0.2.3', true);
    sat('0.3.0', '^0.2.3', false);
    sat('0.0.3', '^0.0.3', true);
    sat('0.0.4', '^0.0.3', false);
  });

  test('tilde ranges', () => {
    sat('1.2.3', '~1.2.3', true);
    sat('1.2.9', '~1.2.3', true);
    sat('1.3.0', '~1.2.3', false);
    sat('1.2.0', '~1.2', true);
    sat('1.3.0', '~1.2', false);
    sat('1.9.0', '~1', true);
    sat('2.0.0', '~1', false);
  });

  test('wildcards and partials', () => {
    sat('99.0.0', '*', true);
    sat('0.0.1', '*', true);
    sat('1.0.0', '1.x', true);
    sat('1.9.9', '1.x', true);
    sat('2.0.0', '1.x', false);
    sat('0.9.9', '1.x', false);
    sat('1.2.0', '1.2.x', true);
    sat('1.3.0', '1.2.x', false);
    sat('1.5.0', '1', true);
    sat('2.0.0', '1', false);
  });

  test('prerelease and v-prefix normalize to numeric core', () => {
    sat('1.6.0-rc.1', '>=1.6.0', true);
    sat('1.5.1-dev.0', '>=1.6.0', false);
    sat('v1.6.0', '>=1.6.0', true);
  });

  test('FAIL CLOSED on empty/unparseable ranges', () => {
    for (const bad of ['', '   ', 'abc', 'not a range', '>=', '>=x', 'foo.bar.baz', '1.2.3.4', '>=1.2.3 garbage']) {
      sat('1.6.0', bad, false);
    }
  });

  test('FAIL CLOSED on malformed wildcard tokens (concrete segment after a wildcard)', () => {
    for (const bad of ['1.x.2', '>=1.x.2', '1.*.2', '1.X.0']) {
      sat('1.5.0', bad, false);
    }
  });

  test('null/undefined inputs do not throw and fail closed', () => {
    sat('1.6.0', null, false);
    sat('1.6.0', undefined, false);
    sat(null, '>=1.6.0', false); // null version -> [0,0,0] -> not >= 1.6.0
  });
});
