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
  test('classifyConfidence({provider: any, verifiedAgainstOfficial: any}) never throws', () => {
    fc.assert(
      fc.property(
        fc.anything(),
        fc.anything(),
        (provider, verifiedAgainstOfficial) => {
          let result;
          assert.doesNotThrow(() => {
            result = classifyConfidence({ provider, verifiedAgainstOfficial });
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
