'use strict';

/**
 * Property-based tests for research-store.cjs
 *
 * Properties tested:
 *   (a) researchKey: never throws on arbitrary inputs (optional strings/null/undefined/numbers)
 *   (b) researchKey: stable — same input object produces same key on two calls
 *   (c) researchKey: collision-resistant — inputs that differ in a normalizable field
 *       produce different cache keys (distinct strings after trim/lowercase still hash
 *       to distinct keys)
 *
 * Boundary examples:
 *   Concrete pairs that MUST NOT collide (ecosystem/library combos, version variants,
 *   query differences).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const { researchKey } = require('../gsd-core/bin/lib/research-store.cjs');

// ---------------------------------------------------------------------------
// Arbitrary helpers
// ---------------------------------------------------------------------------

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

/**
 * Two distinct non-empty strings that remain distinct after trim + lowercase
 * (i.e. they are not case/whitespace variants of each other).
 */
const twoDistinctStrings = fc
  .tuple(
    fc.string({ minLength: 1 }),
    fc.string({ minLength: 1 })
  )
  .filter(([a, b]) => a.trim().toLowerCase() !== b.trim().toLowerCase());

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

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

  test('property: collision-resistant — inputs differing in ecosystem produce distinct keys', () => {
    // Vary ecosystem only; hold all other fields constant so only ecosystem distinguishes them.
    fc.assert(
      fc.property(
        twoDistinctStrings,
        arbitraryInput,
        ([ecoA, ecoB], base) => {
          const inputA = { ...base, ecosystem: ecoA };
          const inputB = { ...base, ecosystem: ecoB };
          assert.notEqual(
            researchKey(inputA),
            researchKey(inputB),
            `ecosystem "${ecoA}" and "${ecoB}" must not collide`
          );
        }
      )
    );
  });

  test('property: collision-resistant — inputs differing in library produce distinct keys', () => {
    fc.assert(
      fc.property(
        twoDistinctStrings,
        arbitraryInput,
        ([libA, libB], base) => {
          const inputA = { ...base, library: libA };
          const inputB = { ...base, library: libB };
          assert.notEqual(
            researchKey(inputA),
            researchKey(inputB),
            `library "${libA}" and "${libB}" must not collide`
          );
        }
      )
    );
  });

  test('property: collision-resistant — inputs differing in query produce distinct keys', () => {
    fc.assert(
      fc.property(
        twoDistinctStrings,
        arbitraryInput,
        ([qA, qB], base) => {
          const inputA = { ...base, query: qA };
          const inputB = { ...base, query: qB };
          assert.notEqual(
            researchKey(inputA),
            researchKey(inputB),
            `query "${qA}" and "${qB}" must not collide`
          );
        }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Boundary / concrete collision examples
// ---------------------------------------------------------------------------

describe('research-store: researchKey boundary examples', () => {
  // npm/lodash vs npm/react — same ecosystem, different library
  test('boundary: "npm/lodash" and "npm/react" must not collide', () => {
    const lodash = researchKey({ ecosystem: 'npm', library: 'lodash' });
    const react = researchKey({ ecosystem: 'npm', library: 'react' });
    assert.notEqual(lodash, react, '"npm/lodash" and "npm/react" produced the same cache key');
  });

  // Same library, different ecosystem
  test('boundary: "npm/lodash" and "pypi/lodash" must not collide', () => {
    const npm = researchKey({ ecosystem: 'npm', library: 'lodash' });
    const pypi = researchKey({ ecosystem: 'pypi', library: 'lodash' });
    assert.notEqual(npm, pypi, '"npm/lodash" and "pypi/lodash" produced the same cache key');
  });

  // Different versions of the same library
  test('boundary: "npm/lodash@4" and "npm/lodash@3" must not collide', () => {
    const v4 = researchKey({ ecosystem: 'npm', library: 'lodash', version: '4' });
    const v3 = researchKey({ ecosystem: 'npm', library: 'lodash', version: '3' });
    assert.notEqual(v4, v3, '"npm/lodash@4" and "npm/lodash@3" produced the same cache key');
  });

  // Different query for the same library
  test('boundary: same library with different queries must not collide', () => {
    const usage = researchKey({ ecosystem: 'npm', library: 'react', query: 'hooks usage' });
    const migration = researchKey({ ecosystem: 'npm', library: 'react', query: 'migration guide' });
    assert.notEqual(usage, migration, 'react "hooks usage" and "migration guide" queries produced the same cache key');
  });

  // Different kind for the same library
  test('boundary: same library with different kinds must not collide', () => {
    const api = researchKey({ ecosystem: 'npm', library: 'lodash', kind: 'api' });
    const guide = researchKey({ ecosystem: 'npm', library: 'lodash', kind: 'guide' });
    assert.notEqual(api, guide, 'lodash "api" and "guide" kinds produced the same cache key');
  });

  // Determinism: researchKey is stable across calls with the same concrete input
  test('boundary: determinism holds for concrete "npm/lodash" input', () => {
    const input = { ecosystem: 'npm', library: 'lodash', version: '4.17.21', query: 'installation', kind: 'api' };
    const k1 = researchKey(input);
    const k2 = researchKey(input);
    assert.equal(k1, k2, '"npm/lodash" key is not stable across two calls');
    assert.match(k1, /^[0-9a-f]{64}$/, '"npm/lodash" key is not a 64-char hex string');
  });

  // Normalization: case and whitespace variants must NOT collide with the canonical form
  // (because different ecosystems/libraries should be different, but case-only variants
  // are treated as the same lookup key — this tests that normalization is applied)
  test('boundary: case-only variants produce the SAME key (normalization applied)', () => {
    const lower = researchKey({ ecosystem: 'npm', library: 'lodash' });
    const upper = researchKey({ ecosystem: 'NPM', library: 'LODASH' });
    assert.equal(lower, upper, 'case variants of the same library should map to the same cache key after normalization');
  });

  test('boundary: whitespace-padded inputs produce the SAME key as trimmed inputs', () => {
    const trimmed = researchKey({ ecosystem: 'npm', library: 'react' });
    const padded = researchKey({ ecosystem: '  npm  ', library: '  react  ' });
    assert.equal(trimmed, padded, 'whitespace-padded inputs should produce the same key as trimmed inputs');
  });
});
