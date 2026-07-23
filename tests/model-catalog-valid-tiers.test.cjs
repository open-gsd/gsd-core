'use strict';

/**
 * Regression/parity tests for VALID_TIERS and RUNTIME_OVERRIDE_TIERS (#2070).
 *
 * src/model-resolver.cts:336 currently declares a function-local,
 * non-exported `VALID_TIERS` set. src/model-catalog.cts now exports a
 * `VALID_TIERS` computed as `[...Object.values(catalog.adaptiveTierMap),
 * 'inherit']`. NOTE: a value-equality assertion against that same derivation
 * cannot, by construction, distinguish "genuinely catalog-derived" from "a
 * hardcoded literal that happens to equal today's catalog output" — both
 * would pass this test. What this test actually guarantees is narrower but
 * still useful: VALID_TIERS equals the catalog-derived set right now, so it
 * fails loudly the moment the two go out of sync (e.g. someone drops
 * 'inherit', or model-catalog.json gains/loses a tier and VALID_TIERS isn't
 * updated to match) — an impl/catalog divergence guard, not a
 * hardcoding detector.
 *
 * The RUNTIME_OVERRIDE_TIERS tests below cover review finding #7: a second,
 * independent hardcoded tier list at src/config-loader.cts:193
 * (`new Set(['opus', 'sonnet', 'haiku'])`, exported at line 769) is a
 * parallel surface to VALID_TIERS. Fixed to derive from
 * `Object.values(catalog.adaptiveTierMap)` (which — unlike VALID_TIERS —
 * does NOT include 'inherit'), the parity assertion below fails loudly if
 * RUNTIME_OVERRIDE_TIERS and VALID_TIERS ever drift apart.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { catalog, VALID_TIERS } = require('../gsd-core/bin/lib/model-catalog.cjs');
const { RUNTIME_OVERRIDE_TIERS } = require('../gsd-core/bin/lib/config-loader.cjs');

describe('model-catalog VALID_TIERS derivation (#2070)', () => {
  test('VALID_TIERS equals the catalog-derived set (adaptiveTierMap values plus "inherit") — catches impl/catalog divergence', () => {
    const expected = new Set([...Object.values(catalog.adaptiveTierMap), 'inherit']);
    assert.deepStrictEqual(
      VALID_TIERS,
      expected,
      `VALID_TIERS must match catalog.adaptiveTierMap-derived tiers plus 'inherit': ${JSON.stringify([...(VALID_TIERS || [])])}`
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

describe('config-loader RUNTIME_OVERRIDE_TIERS derivation (#2070 review finding 7)', () => {
  test('RUNTIME_OVERRIDE_TIERS equals catalog.adaptiveTierMap values (no "inherit")', () => {
    const expected = new Set(Object.values(catalog.adaptiveTierMap));
    assert.deepStrictEqual(
      RUNTIME_OVERRIDE_TIERS,
      expected,
      `RUNTIME_OVERRIDE_TIERS must be derived from catalog.adaptiveTierMap, not hardcoded: ${JSON.stringify([...(RUNTIME_OVERRIDE_TIERS || [])])}`
    );
  });

  test('RUNTIME_OVERRIDE_TIERS pins current tier set to opus/sonnet/haiku', () => {
    assert.deepStrictEqual(
      RUNTIME_OVERRIDE_TIERS,
      new Set(['opus', 'sonnet', 'haiku']),
      `Expected RUNTIME_OVERRIDE_TIERS to equal {opus, sonnet, haiku}, got: ${JSON.stringify([...(RUNTIME_OVERRIDE_TIERS || [])])}`
    );
  });

  test('RUNTIME_OVERRIDE_TIERS ∪ {"inherit"} equals VALID_TIERS (parity — fails loudly if the two surfaces drift)', () => {
    const union = new Set([...RUNTIME_OVERRIDE_TIERS, 'inherit']);
    assert.deepStrictEqual(
      union,
      VALID_TIERS,
      `RUNTIME_OVERRIDE_TIERS plus 'inherit' must equal VALID_TIERS — these are two parallel tier-list surfaces that must never diverge: ` +
      `RUNTIME_OVERRIDE_TIERS=${JSON.stringify([...(RUNTIME_OVERRIDE_TIERS || [])])}, VALID_TIERS=${JSON.stringify([...(VALID_TIERS || [])])}`
    );
  });
});
