'use strict';

/**
 * Property-based tests for package-legitimacy.cjs
 *
 * RULESET.TESTS.property-based-testing: classifyPackage never throws on
 * arbitrary partial signals and always returns verdict in {OK, SUS, SLOP}.
 *
 * Requires helpers/fast-check-setup.cjs (seeds fc globally).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { classifyPackage } = require('../gsd-core/bin/lib/package-legitimacy.cjs');

const FIXED_MS = Date.UTC(2024, 0, 1, 0, 0, 0, 0);
const fixedClock = { now: () => FIXED_MS };
const VALID_VERDICTS = new Set(['OK', 'SUS', 'SLOP']);

// ---------------------------------------------------------------------------
// Arbitrary signals generator — covers partial, missing, and odd-typed fields
// ---------------------------------------------------------------------------

const arbitrarySignals = fc.record(
  {
    exists: fc.oneof(fc.boolean(), fc.constant(null), fc.constant(undefined)),
    publishedAt: fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
      fc.date().map((d) => d.toISOString()),
      fc.integer(), // non-string weirdness
    ),
    weeklyDownloads: fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.integer({ min: -1, max: 1_000_000 }),
      fc.string(), // odd type
    ),
    repoUrl: fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
    ),
    deprecated: fc.oneof(fc.boolean(), fc.constant(null), fc.constant(undefined)),
    postinstall: fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
    ),
    ecosystem: fc.oneof(
      fc.constant('npm'),
      fc.constant('pypi'),
      fc.constant('crates'),
      fc.constant(null),
      fc.string(),
    ),
  },
  { requiredKeys: [] } // all fields optional
);

// ---------------------------------------------------------------------------
// Property: classifyPackage never throws; verdict always in {OK,SUS,SLOP}
// ---------------------------------------------------------------------------

describe('property: classifyPackage never throws on arbitrary partial signals', () => {
  test('verdict is always OK | SUS | SLOP', () => {
    fc.assert(
      fc.property(arbitrarySignals, (signals) => {
        let result;
        assert.doesNotThrow(() => {
          result = classifyPackage(signals, { clock: fixedClock });
        });
        assert.ok(
          VALID_VERDICTS.has(result.verdict),
          `Expected verdict in {OK,SUS,SLOP} but got: ${String(result.verdict)}`
        );
        assert.ok(Array.isArray(result.reasons), 'reasons must be an array');
      })
    );
  });

  test('SLOP verdict only appears when exists===false', () => {
    fc.assert(
      fc.property(arbitrarySignals, (signals) => {
        let result;
        assert.doesNotThrow(() => {
          result = classifyPackage(signals, { clock: fixedClock });
        });
        if (result.verdict === 'SLOP') {
          assert.equal(
            signals.exists,
            false,
            'SLOP verdict should only occur when exists===false'
          );
        }
      })
    );
  });

  test('reasons is always a non-empty array when verdict is SUS or SLOP', () => {
    fc.assert(
      fc.property(arbitrarySignals, (signals) => {
        let result;
        assert.doesNotThrow(() => {
          result = classifyPackage(signals, { clock: fixedClock });
        });
        if (result.verdict === 'SUS' || result.verdict === 'SLOP') {
          assert.ok(
            result.reasons.length > 0,
            `Non-OK verdict must have at least one reason; got: ${JSON.stringify(result)}`
          );
        }
        if (result.verdict === 'OK') {
          assert.equal(
            result.reasons.length,
            0,
            `OK verdict must have no reasons; got: ${JSON.stringify(result.reasons)}`
          );
        }
      })
    );
  });
});
