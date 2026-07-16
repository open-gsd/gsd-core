'use strict';

/**
 * Regression/parity tests for VALID_TIERS (#2070).
 *
 * src/model-resolver.cts:336 currently declares a function-local,
 * non-exported `VALID_TIERS` set. This pins the expectation that
 * src/model-catalog.cts will export a `VALID_TIERS` derived from the
 * catalog (adaptiveTierMap values + 'inherit'), not hardcoded, so a future
 * catalog change that would silently alter the resolver's gate fails loudly.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { catalog, VALID_TIERS } = require('../gsd-core/bin/lib/model-catalog.cjs');

describe('model-catalog VALID_TIERS derivation (#2070)', () => {
  test('VALID_TIERS is derived from catalog.adaptiveTierMap values plus "inherit"', () => {
    const expected = new Set([...Object.values(catalog.adaptiveTierMap), 'inherit']);
    assert.deepStrictEqual(
      VALID_TIERS,
      expected,
      `VALID_TIERS must be derived from catalog.adaptiveTierMap, not hardcoded: ${JSON.stringify([...(VALID_TIERS || [])])}`
    );
  });

  test('VALID_TIERS pins current tier set to opus/sonnet/haiku/inherit', () => {
    assert.deepStrictEqual(
      VALID_TIERS,
      new Set(['opus', 'sonnet', 'haiku', 'inherit']),
      `Expected VALID_TIERS to equal {opus, sonnet, haiku, inherit}, got: ${JSON.stringify([...(VALID_TIERS || [])])}`
    );
  });
});
