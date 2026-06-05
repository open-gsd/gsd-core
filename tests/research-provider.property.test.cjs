'use strict';

/**
 * Property-based tests for research-provider.cjs
 *
 * Cycle 8: classifyConfidence never throws on arbitrary inputs.
 * RULESET.TESTS.property-based-testing
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { classifyConfidence } = require('../gsd-core/bin/lib/research-provider.cjs');

// ---------------------------------------------------------------------------
// Cycle 8: classifyConfidence never throws on arbitrary inputs
// ---------------------------------------------------------------------------

describe('research-provider property: classifyConfidence never throws', () => {
  test('classifyConfidence({provider: any, verifiedAgainstOfficial: any, legitimacyVerdict: any}) never throws', () => {
    // Sample legitimacyVerdict from values an agent might supply or that arrive via checkPackages
    const legitimacyVerdictArb = fc.oneof(
      fc.constant('OK'),
      fc.constant('SUS'),
      fc.constant('SLOP'),
      fc.constant(undefined),
      fc.constant(null),
      fc.integer(),
      fc.anything(),
    );
    fc.assert(
      fc.property(
        fc.anything(),
        fc.anything(),
        legitimacyVerdictArb,
        (provider, verifiedAgainstOfficial, legitimacyVerdict) => {
          let result;
          assert.doesNotThrow(() => {
            result = classifyConfidence({ provider, verifiedAgainstOfficial, legitimacyVerdict });
          });
          // Must return one of the three valid confidence levels
          assert.ok(
            result === 'HIGH' || result === 'MEDIUM' || result === 'LOW',
            `Expected HIGH|MEDIUM|LOW but got: ${String(result)}`
          );
        }
      )
    );
  });
});
