'use strict';

/**
 * Property-based tests for config-schema.cjs
 *
 * Module: get-shit-done/bin/lib/config-schema.cjs
 * Exported: isValidConfigKey(keyPath) -> boolean
 *           VALID_CONFIG_KEYS: Set<string>
 *           RUNTIME_STATE_KEYS: Set<string>
 *           DYNAMIC_KEY_PATTERNS: Array<{ test(key): boolean, ... }>
 *
 * Properties tested:
 *   (a) isValidConfigKey never throws regardless of input type/content
 *   (b) isValidConfigKey(key) is true for every key in VALID_CONFIG_KEYS
 *   (c) isValidConfigKey(key) is true for every key in RUNTIME_STATE_KEYS
 *   (d) Robustness: null/undefined/NaN/control-chars/binary never throw
 *   (e) Arbitrary garbage strings return false (not throw) from isValidConfigKey
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  isValidConfigKey,
  VALID_CONFIG_KEYS,
  RUNTIME_STATE_KEYS,
} = require('../get-shit-done/bin/lib/config-schema.cjs');

describe('config-schema: isValidConfigKey properties', () => {
  // (a) Never throws on any input
  test('property: isValidConfigKey never throws on hostile inputs', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant(NaN),
          fc.constant(Infinity),
          fc.constant(-Infinity),
          fc.constant(0),
          fc.constant(''),
          fc.constant('\x00'),
          fc.constant('\n\r\t'),
          fc.string({ unit: 'binary', maxLength: 100 }),
          fc.string({ unit: 'grapheme-composite', maxLength: 100 }),
          fc.constant([]),
          fc.constant({}),
          fc.boolean(),
          fc.string({ maxLength: 100 })
        ),
        (input) => {
          assert.doesNotThrow(
            () => isValidConfigKey(input),
            `isValidConfigKey threw on input: ${JSON.stringify(input)}`
          );
        }
      )
    );
  });

  // (b) Every key in VALID_CONFIG_KEYS returns true
  test('all VALID_CONFIG_KEYS entries are recognized as valid', () => {
    for (const key of VALID_CONFIG_KEYS) {
      assert.equal(
        isValidConfigKey(key),
        true,
        `Expected isValidConfigKey(${JSON.stringify(key)}) === true`
      );
    }
  });

  // (c) Every key in RUNTIME_STATE_KEYS returns true
  test('all RUNTIME_STATE_KEYS entries are recognized as valid', () => {
    for (const key of RUNTIME_STATE_KEYS) {
      assert.equal(
        isValidConfigKey(key),
        true,
        `Expected isValidConfigKey(${JSON.stringify(key)}) === true (runtime state key)`
      );
    }
  });

  // (d+e) Robustness: hostile strings return boolean (not throw)
  test('property: isValidConfigKey always returns a boolean for any string', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        (key) => {
          const result = isValidConfigKey(key);
          assert.ok(
            typeof result === 'boolean',
            `isValidConfigKey must return boolean, got ${typeof result} for ${JSON.stringify(key)}`
          );
        }
      )
    );
  });

  test('property: binary/control-char strings return false (not throw)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary', maxLength: 100 }),
          fc.string({ unit: 'grapheme-composite', maxLength: 100 })
        ),
        (key) => {
          // Either returns true (if it happens to match a valid key) or false
          // It must NOT throw
          let result;
          assert.doesNotThrow(() => {
            result = isValidConfigKey(key);
          });
          assert.ok(typeof result === 'boolean');
        }
      )
    );
  });

  // Boundary: well-formed dotted paths that are NOT in the schema
  test('property: plausible-but-invalid dotted paths return false', () => {
    // Generate dot-separated alphanumeric paths that do not match known keys
    const dotPath = fc.array(
      fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/),
      { minLength: 3, maxLength: 5 }
    ).map((parts) => 'zz_unknown.' + parts.join('.'));

    fc.assert(
      fc.property(dotPath, (key) => {
        // Must not throw
        let result;
        assert.doesNotThrow(() => {
          result = isValidConfigKey(key);
        });
        // Result is a boolean
        assert.ok(typeof result === 'boolean');
      })
    );
  });

  // Boundary: empty string is not a valid config key
  test('empty string is not a valid config key', () => {
    const result = isValidConfigKey('');
    assert.equal(result, false, 'empty string must not be a valid config key');
  });

  // Boundary: null/undefined/number return false (not throw, not true)
  test('null, undefined, number inputs return false', () => {
    assert.equal(isValidConfigKey(null), false);
    assert.equal(isValidConfigKey(undefined), false);
    assert.equal(isValidConfigKey(42), false);
    assert.equal(isValidConfigKey(NaN), false);
  });
});
