'use strict';

/**
 * #5231 — git.commit_timeout_ms: one rule, one default. The reader (`commitTimeoutMs`) and the
 * `config-set` validator (`isValidCommitTimeoutMs`) are the same predicate by construction; these
 * tests pin that, the boundaries, and that the declared defaults cannot drift from the constant.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const {
  COMMIT_TIMEOUT_DEFAULT_MS: DEFAULT,
  COMMIT_TIMEOUT_MAX_MS: MAX,
  isValidCommitTimeoutMs,
  commitTimeoutMs,
} = require(path.join(LIB, 'git-commit-timeout.cjs'));

describe('#5231 git.commit_timeout_ms rule', () => {
  const accepted = [['0 (below the lower bound)', 0, false], ['1', 1, true], ['2', 2, true],
    ['ceiling-1', MAX - 1, true], ['ceiling', MAX, true], ['ceiling+1', MAX + 1, false],
    ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER, false], ['MAX_SAFE_INTEGER+1', Number.MAX_SAFE_INTEGER + 1, false]];
  for (const [label, value, ok] of accepted) {
    test(`boundary ${label} (${value}) -> ${ok ? 'accepted' : 'default'}`, () => {
      assert.equal(isValidCommitTimeoutMs(value), ok);
      assert.equal(commitTimeoutMs(value), ok ? value : DEFAULT);
    });
  }

  // Valid and invalid inputs come from disjoint generators, so the oracle is the partition, not a copy of the predicate.
  test('property: every integer in [1, ceiling] is returned unchanged', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: MAX }), (v) => {
      assert.equal(isValidCommitTimeoutMs(v), true);
      assert.equal(commitTimeoutMs(v), v);
    }));
  });

  test('property: anything else resolves to the default', () => {
    const outOfRange = fc.oneof(fc.integer({ min: -1_000_000, max: 0 }), fc.integer({ min: MAX + 1, max: Number.MAX_SAFE_INTEGER }));
    const notAnInteger = fc.double({ noInteger: true }); // fractions, NaN, ±Infinity
    const notANumber = fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined), fc.boolean(), fc.array(fc.integer()));
    fc.assert(fc.property(fc.oneof(outOfRange, notAnInteger, notANumber), (v) => {
      assert.equal(isValidCommitTimeoutMs(v), false);
      assert.equal(commitTimeoutMs(v), DEFAULT);
    }));
  });

  test('the defaults manifest value equals the constant (config-get parity is in config.test.cjs)', () => {
    const manifest = require('../gsd-core/bin/shared/config-defaults.manifest.json');
    assert.equal(manifest.git.commit_timeout_ms, DEFAULT);
  });
});
