'use strict';

/**
 * Property-based tests for research-store.cjs
 *
 * Properties tested:
 *   (a) researchKey: never throws on arbitrary inputs (optional strings/null/undefined/numbers)
 *   (b) researchKey: stable across two calls for the same input object
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { researchKey } = require('../gsd-core/bin/lib/research-store.cjs');

const arbitraryField = fc.oneof(
  fc.string(),
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.float({ noNaN: true }),
  fc.boolean()
);

const arbitraryInput = fc.record(
  {
    ecosystem: arbitraryField,
    library: arbitraryField,
    version: arbitraryField,
    query: arbitraryField,
    kind: arbitraryField,
  },
  { requiredKeys: [] }
);

describe('research-store: researchKey property tests', () => {
  test('property: never throws on arbitrary inputs', () => {
    fc.assert(
      fc.property(arbitraryInput, (input) => {
        assert.doesNotThrow(() => researchKey(input));
      })
    );
  });

  test('property: stable — same input object produces same key on two calls', () => {
    fc.assert(
      fc.property(arbitraryInput, (input) => {
        const k1 = researchKey(input);
        const k2 = researchKey(input);
        assert.equal(k1, k2);
      })
    );
  });

  test('property: always returns a 64-char hex string', () => {
    fc.assert(
      fc.property(arbitraryInput, (input) => {
        const k = researchKey(input);
        assert.match(k, /^[0-9a-f]{64}$/);
      })
    );
  });
});
