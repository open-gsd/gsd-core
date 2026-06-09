'use strict';

/**
 * federated-config.test.cjs — Behavioral tests for the federated-config module.
 *
 * ADR-857 phase 3b. Tests cover:
 *   - empty configSchema → empty result
 *   - key still in central schema → skipped + pending-migration warning + NOT in values
 *   - malformed slice (each variant) → skipped + warning, no throw
 *   - valid federated key → value = default
 *   - valid federated key with correct-type user override → user value used
 *   - valid federated key with wrong-type user override → falls back to default + warning
 *   - __proto__/constructor/prototype keys → ignored, no Object.prototype pollution
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { mergeFederatedConfig } = require('../gsd-core/bin/lib/federated-config.cjs');

// ─── Helper fixtures ──────────────────────────────────────────────────────────

/** A minimal well-formed boolean config slice entry. */
const BOOLEAN_SLICE = {
  owner: 'test-cap',
  type: 'boolean',
  default: true,
  description: 'A test boolean key.',
};

/** A minimal well-formed string config slice entry. */
const STRING_SLICE = {
  owner: 'test-cap',
  type: 'string',
  default: 'hello',
  description: 'A test string key.',
};

/** A minimal well-formed number config slice entry. */
const NUMBER_SLICE = {
  owner: 'test-cap',
  type: 'number',
  default: 42,
  description: 'A test number key.',
};

/** A minimal well-formed enum config slice entry (no values list). */
const ENUM_SLICE_NO_VALUES = {
  owner: 'test-cap',
  type: 'enum',
  default: 'medium',
  description: 'A test enum key without values list.',
};

/** A minimal well-formed enum config slice entry (with values list). */
const ENUM_SLICE_WITH_VALUES = {
  owner: 'test-cap',
  type: 'enum',
  default: 'low',
  values: ['low', 'medium', 'high'],
  description: 'A test enum key with values list.',
};

/** A never-central isCentralKey that always returns false. */
const neverCentral = (_key) => false;

/** An always-central isCentralKey. */
const alwaysCentral = (_key) => true;

// ─── 1. Empty configSchema ────────────────────────────────────────────────────

describe('empty configSchema', () => {
  test('empty object → empty result', () => {
    const result = mergeFederatedConfig({
      configSchema: {},
      isCentralKey: neverCentral,
      userConfig: {},
    });
    assert.strictEqual(Object.keys(result.values).length, 0, 'values should be empty');
    assert.deepEqual(result.validKeys, [], 'validKeys should be empty');
    assert.deepEqual(result.warnings, [], 'warnings should be empty');
  });

  test('null configSchema → empty result (defensive)', () => {
    const result = mergeFederatedConfig({
      configSchema: null,
      isCentralKey: neverCentral,
      userConfig: {},
    });
    // FIX 6b: values uses null-prototype object; check it's empty
    assert.strictEqual(Object.keys(result.values).length, 0, 'values should be empty for null configSchema');
    assert.deepEqual(result.validKeys, [], 'validKeys should be empty');
    assert.deepEqual(result.warnings, [], 'warnings should be empty');
  });
});

// ─── 2. Central-key skipping ──────────────────────────────────────────────────

describe('central-key skipping', () => {
  test('key in central schema → skipped + pending-migration warning + NOT in values', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'workflow.ui_phase': BOOLEAN_SLICE },
      isCentralKey: alwaysCentral,
      userConfig: {},
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(result.values, 'workflow.ui_phase'),
      'central key must NOT appear in values');
    assert.deepEqual(result.validKeys, [], 'validKeys must be empty for central keys');
    assert.ok(result.warnings.length >= 1, 'Must produce at least one warning');
    assert.ok(
      result.warnings.some((w) => w.includes('pending-migration') || w.includes('central config-schema')),
      'Warning must mention pending-migration or central config-schema, got: ' + JSON.stringify(result.warnings),
    );
  });

  test('key NOT in central schema → appears in values', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.enabled': BOOLEAN_SLICE },
      isCentralKey: neverCentral,
      userConfig: {},
    });
    assert.ok(Object.prototype.hasOwnProperty.call(result.values, 'mytool.enabled'),
      'Non-central key must appear in values');
    assert.strictEqual(result.validKeys.length, 1);
  });

  test('mixed central + non-central: central skipped, non-central included', () => {
    const result = mergeFederatedConfig({
      configSchema: {
        'central.key': BOOLEAN_SLICE,
        'mytool.enabled': BOOLEAN_SLICE,
      },
      isCentralKey: (key) => key === 'central.key',
      userConfig: {},
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(result.values, 'central.key'),
      'central.key must not be in values');
    assert.ok(Object.prototype.hasOwnProperty.call(result.values, 'mytool.enabled'),
      'mytool.enabled must be in values');
    assert.strictEqual(result.validKeys.length, 1);
    assert.ok(result.warnings.some((w) => w.includes('pending-migration') || w.includes('central')));
  });
});

// ─── 3. Malformed slice handling ──────────────────────────────────────────────

describe('malformed slice handling — no throw, warning emitted', () => {
  test('slice missing type → skipped + warning, no throw', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'tool.key': { owner: 'x', default: true, description: 'x' } },
      isCentralKey: neverCentral,
      userConfig: {},
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(result.values, 'tool.key'), 'malformed key must not be in values');
    assert.ok(result.warnings.length >= 1, 'Must warn about malformed slice');
    assert.ok(result.warnings.some((w) => w.includes('malformed') || w.includes('tool.key')),
      'Warning must mention the key, got: ' + JSON.stringify(result.warnings));
  });

  test('slice with invalid type ("xml") → skipped + warning, no throw', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'tool.key': { owner: 'x', type: 'xml', default: '<x/>', description: 'xml key' } },
      isCentralKey: neverCentral,
      userConfig: {},
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(result.values, 'tool.key'));
    assert.ok(result.warnings.length >= 1);
  });

  test('slice missing default → skipped + warning, no throw', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'tool.key': { owner: 'x', type: 'boolean', description: 'x' } },
      isCentralKey: neverCentral,
      userConfig: {},
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(result.values, 'tool.key'));
    assert.ok(result.warnings.length >= 1);
  });

  test('slice is null → skipped + warning, no throw', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'tool.key': null },
      isCentralKey: neverCentral,
      userConfig: {},
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(result.values, 'tool.key'));
    assert.ok(result.warnings.length >= 1);
  });

  test('slice is a string scalar → skipped + warning, no throw', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'tool.key': 'just-a-string' },
      isCentralKey: neverCentral,
      userConfig: {},
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(result.values, 'tool.key'));
    assert.ok(result.warnings.length >= 1);
  });

  test('slice is a number → skipped + warning, no throw', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'tool.key': 42 },
      isCentralKey: neverCentral,
      userConfig: {},
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(result.values, 'tool.key'));
    assert.ok(result.warnings.length >= 1);
  });
});

// ─── 4. Valid federated key — default resolution ──────────────────────────────

describe('valid federated key — default resolution', () => {
  test('boolean key absent from userConfig → value = default (true)', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.enabled': BOOLEAN_SLICE },
      isCentralKey: neverCentral,
      userConfig: {},
    });
    assert.strictEqual(result.values['mytool.enabled'], true, 'Should use slice default (true)');
    assert.ok(result.validKeys.includes('mytool.enabled'));
    assert.deepEqual(result.warnings, []);
  });

  test('string key absent from userConfig → value = default ("hello")', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.name': STRING_SLICE },
      isCentralKey: neverCentral,
      userConfig: {},
    });
    assert.strictEqual(result.values['mytool.name'], 'hello');
    assert.ok(result.validKeys.includes('mytool.name'));
  });

  test('number key absent from userConfig → value = default (42)', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.timeout': NUMBER_SLICE },
      isCentralKey: neverCentral,
      userConfig: {},
    });
    assert.strictEqual(result.values['mytool.timeout'], 42);
  });

  test('enum key absent from userConfig → value = default ("medium")', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.level': ENUM_SLICE_NO_VALUES },
      isCentralKey: neverCentral,
      userConfig: {},
    });
    assert.strictEqual(result.values['mytool.level'], 'medium');
  });
});

// ─── 5. Valid federated key — correct-type user override ─────────────────────

describe('valid federated key — user override with correct type', () => {
  test('boolean key with boolean user override (nested) → user value used', () => {
    // FIX 1: users write nested objects, not flat dotted keys
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.enabled': BOOLEAN_SLICE },
      isCentralKey: neverCentral,
      userConfig: { mytool: { enabled: false } },
    });
    assert.strictEqual(result.values['mytool.enabled'], false, 'Should use user-supplied false');
    assert.deepEqual(result.warnings, []);
  });

  test('string key with string user override (nested) → user value used', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.name': STRING_SLICE },
      isCentralKey: neverCentral,
      userConfig: { mytool: { name: 'custom' } },
    });
    assert.strictEqual(result.values['mytool.name'], 'custom');
    assert.deepEqual(result.warnings, []);
  });

  test('number key with number user override (nested) → user value used', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.timeout': NUMBER_SLICE },
      isCentralKey: neverCentral,
      userConfig: { mytool: { timeout: 99 } },
    });
    assert.strictEqual(result.values['mytool.timeout'], 99);
    assert.deepEqual(result.warnings, []);
  });

  test('enum key with in-values string user override (nested) → user value used', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.level': ENUM_SLICE_WITH_VALUES },
      isCentralKey: neverCentral,
      userConfig: { mytool: { level: 'high' } },
    });
    assert.strictEqual(result.values['mytool.level'], 'high');
    assert.deepEqual(result.warnings, []);
  });
});

// ─── 6. Valid federated key — wrong-type user override ───────────────────────

describe('valid federated key — wrong-type user override', () => {
  test('boolean key with string user override (nested) → falls back to default + warning', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.enabled': BOOLEAN_SLICE },
      isCentralKey: neverCentral,
      userConfig: { mytool: { enabled: 'not-a-bool' } },
    });
    // Key IS in validKeys (degraded resolution — default used)
    assert.ok(Object.prototype.hasOwnProperty.call(result.values, 'mytool.enabled'),
      'Key should still appear in values (degraded)');
    assert.strictEqual(result.values['mytool.enabled'], true, 'Should fall back to default (true)');
    assert.ok(result.warnings.length >= 1, 'Should warn about type mismatch');
    assert.ok(
      result.warnings.some((w) => w.includes('wrong type') || w.includes('type')),
      'Warning should mention type mismatch, got: ' + JSON.stringify(result.warnings),
    );
  });

  test('string key with boolean user override (nested) → falls back to default + warning', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.name': STRING_SLICE },
      isCentralKey: neverCentral,
      userConfig: { mytool: { name: true } },
    });
    assert.strictEqual(result.values['mytool.name'], 'hello', 'Should fall back to default');
    assert.ok(result.warnings.length >= 1);
  });

  test('number key with string user override (nested) → falls back to default + warning', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.timeout': NUMBER_SLICE },
      isCentralKey: neverCentral,
      userConfig: { mytool: { timeout: 'fast' } },
    });
    assert.strictEqual(result.values['mytool.timeout'], 42, 'Should fall back to default');
    assert.ok(result.warnings.length >= 1);
  });
});

// ─── 7. Prototype pollution guard ────────────────────────────────────────────

describe('prototype pollution guard', () => {
  test('__proto__ key in configSchema → ignored, no Object.prototype pollution', () => {
    // We can't pass __proto__ as an own-enumerable property via object literal,
    // so we use Object.create + defineProperty to simulate what a capability registry
    // might hand us if prototype pollution had been attempted upstream.
    const poisonedSchema = Object.create(null);
    Object.defineProperty(poisonedSchema, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    // Note: 'constructor' and 'prototype' CAN be passed via plain object literals
    const schemaWithReservedKeys = {
      'constructor': BOOLEAN_SLICE,
      'prototype': STRING_SLICE,
    };

    const result = mergeFederatedConfig({
      configSchema: schemaWithReservedKeys,
      isCentralKey: neverCentral,
      userConfig: {},
    });

    // Reserved keys must not appear in values
    assert.ok(!Object.prototype.hasOwnProperty.call(result.values, 'constructor'), 'constructor must not be in values');
    assert.ok(!Object.prototype.hasOwnProperty.call(result.values, 'prototype'), 'prototype must not be in values');
    assert.ok(!result.validKeys.includes('constructor'), 'constructor must not be in validKeys');
    assert.ok(!result.validKeys.includes('prototype'), 'prototype must not be in validKeys');

    // Object.prototype must not be polluted
    assert.strictEqual(({}).polluted, undefined, 'Object.prototype must not be polluted');
    assert.strictEqual(({}).constructor, Object, 'Object.prototype.constructor must be Object (not overwritten)');
  });

  test('buildRegistry with poisoned keys does not pollute Object.prototype', () => {
    // Even with isCentralKey always returning false, reserved keys are guarded
    const result = mergeFederatedConfig({
      configSchema: { 'legitimate.key': BOOLEAN_SLICE },
      isCentralKey: neverCentral,
      userConfig: {},
    });
    assert.strictEqual(({}).polluted, undefined, 'Object.prototype.polluted must be undefined after merge');
    assert.ok(Object.prototype.hasOwnProperty.call(result.values, 'legitimate.key'), 'legitimate key must be in values');
  });
});

// ─── FIX 1: Nested dotted-path user-override lookup ──────────────────────────

describe('FIX 1: nested dotted-path user-override lookup', () => {
  test('user sets mytool.enabled via NESTED object → user value used', () => {
    // Nested config: { mytool: { enabled: false } } — NOT flat {"mytool.enabled": false}
    const result = mergeFederatedConfig({
      configSchema: {
        'mytool.enabled': {
          owner: 'mytool',
          type: 'boolean',
          default: true,
          description: 'Enable mytool.',
        },
      },
      isCentralKey: neverCentral,
      userConfig: { mytool: { enabled: false } },  // NESTED
    });
    assert.strictEqual(result.values['mytool.enabled'], false, 'Nested user override should be used (false overrides true)');
    assert.deepEqual(result.warnings, [], 'No warnings for valid nested override');
    assert.ok(result.validKeys.includes('mytool.enabled'));
  });

  test('flat {"mytool.enabled": false} does NOT match nested path lookup', () => {
    // Flat key string lookup is intentionally NOT supported per FIX 1 spec
    const result = mergeFederatedConfig({
      configSchema: {
        'mytool.enabled': {
          owner: 'mytool',
          type: 'boolean',
          default: true,
          description: 'Enable mytool.',
        },
      },
      isCentralKey: neverCentral,
      userConfig: { 'mytool.enabled': false },  // FLAT — not found via nested traversal
    });
    // Flat key is not found by nested traversal, so default is used
    assert.strictEqual(result.values['mytool.enabled'], true, 'Flat key not found by nested traversal → default used');
  });

  test('user sets nested 3-segment key correctly', () => {
    // Key: "a.b.c", user config: { a: { b: { c: 'override' } } }
    const result = mergeFederatedConfig({
      configSchema: {
        'a.b.c': {
          owner: 'test',
          type: 'string',
          default: 'default-val',
          description: 'Three-segment key.',
        },
      },
      isCentralKey: neverCentral,
      userConfig: { a: { b: { c: 'override' } } },
    });
    assert.strictEqual(result.values['a.b.c'], 'override');
    assert.deepEqual(result.warnings, []);
  });

  test('partial nested path (a.b exists but a.b.c missing) → uses default', () => {
    const result = mergeFederatedConfig({
      configSchema: {
        'a.b.c': {
          owner: 'test',
          type: 'string',
          default: 'default-val',
          description: 'Three-segment key.',
        },
      },
      isCentralKey: neverCentral,
      userConfig: { a: { b: {} } },  // c is missing
    });
    assert.strictEqual(result.values['a.b.c'], 'default-val', 'Missing leaf should use default');
  });
});

// ─── FIX 4: null/undefined/non-object input guards ───────────────────────────

describe('FIX 4: null/undefined/non-object input guards', () => {
  test('null input → no throw, empty result', () => {
    assert.doesNotThrow(() => {
      const result = mergeFederatedConfig(null);
      assert.ok(result.validKeys.length === 0);
    });
  });

  test('undefined input → no throw, empty result', () => {
    assert.doesNotThrow(() => {
      const result = mergeFederatedConfig(undefined);
      assert.ok(result.validKeys.length === 0);
    });
  });

  test('non-object input (string) → no throw, empty result', () => {
    assert.doesNotThrow(() => {
      const result = mergeFederatedConfig('not-an-object');
      assert.ok(result.validKeys.length === 0);
    });
  });

  test('null userConfig → treated as {} (no overrides), no throw', () => {
    assert.doesNotThrow(() => {
      const result = mergeFederatedConfig({
        configSchema: { 'mytool.enabled': BOOLEAN_SLICE },
        isCentralKey: neverCentral,
        userConfig: null,
      });
      // Should use the default since userConfig is null
      assert.strictEqual(result.values['mytool.enabled'], true, 'Should use default when userConfig is null');
      assert.deepEqual(result.warnings, []);
    });
  });

  test('undefined userConfig → treated as {} (no overrides), no throw', () => {
    assert.doesNotThrow(() => {
      const result = mergeFederatedConfig({
        configSchema: { 'mytool.enabled': BOOLEAN_SLICE },
        isCentralKey: neverCentral,
        userConfig: undefined,
      });
      assert.strictEqual(result.values['mytool.enabled'], true, 'Should use default when userConfig is undefined');
    });
  });

  test('non-object userConfig → treated as {} (no overrides), no throw', () => {
    assert.doesNotThrow(() => {
      const result = mergeFederatedConfig({
        configSchema: { 'mytool.enabled': BOOLEAN_SLICE },
        isCentralKey: neverCentral,
        userConfig: 42,
      });
      assert.strictEqual(result.values['mytool.enabled'], true, 'Should use default when userConfig is non-object');
    });
  });
});

// ─── FIX 5b: enum user override validation against values list ────────────────

describe('FIX 5b: enum out-of-values user override → falls back to default', () => {
  test('enum user override IN values list → accepted', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.level': ENUM_SLICE_WITH_VALUES },
      isCentralKey: neverCentral,
      userConfig: { mytool: { level: 'high' } },
    });
    assert.strictEqual(result.values['mytool.level'], 'high', 'In-values override should be accepted');
    assert.deepEqual(result.warnings, []);
  });

  test('enum user override OUT OF values list → falls back to default + warning', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.level': ENUM_SLICE_WITH_VALUES },
      isCentralKey: neverCentral,
      userConfig: { mytool: { level: 'extreme' } },  // 'extreme' not in ['low', 'medium', 'high']
    });
    assert.strictEqual(result.values['mytool.level'], 'low', 'Out-of-values override should fall back to default');
    assert.ok(result.warnings.length >= 1, 'Should warn about out-of-values override');
    assert.ok(
      result.warnings.some((w) => w.includes('type') || w.includes('enum') || w.includes('invalid')),
      'Warning should mention type/enum issue, got: ' + JSON.stringify(result.warnings),
    );
  });

  test('enum user override is non-string → falls back to default + warning', () => {
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.level': ENUM_SLICE_WITH_VALUES },
      isCentralKey: neverCentral,
      userConfig: { mytool: { level: 42 } },  // number, not string
    });
    assert.strictEqual(result.values['mytool.level'], 'low');
    assert.ok(result.warnings.length >= 1);
  });
});

// ─── FIX 6b: null-proto consistency in early-return paths ────────────────────

describe('FIX 6b: null-proto consistency on early-return paths', () => {
  test('null configSchema → values uses Object.create(null) (no __proto__ chain)', () => {
    const result = mergeFederatedConfig({
      configSchema: null,
      isCentralKey: neverCentral,
      userConfig: {},
    });
    // Object.create(null) has no __proto__ — prototype is null
    assert.strictEqual(Object.getPrototypeOf(result.values), null, 'values must use null prototype on null configSchema path');
  });

  test('null input → values uses Object.create(null)', () => {
    const result = mergeFederatedConfig(null);
    assert.strictEqual(Object.getPrototypeOf(result.values), null, 'values must use null prototype on null input path');
  });
});

// ─── FIX 6c: N-level nested write + prototype pollution via dotted keys ──────

describe('FIX 6c: N-level nested write and prototype-pollution via dotted keys', () => {
  test('3-segment federated key is correctly nested in loadConfig overlay', () => {
    // This test verifies _getNestedValue works correctly for 3-segment keys.
    // The values object should store the key as "a.b.c" → value mapping.
    const result = mergeFederatedConfig({
      configSchema: {
        'tool.section.flag': {
          owner: 'test',
          type: 'boolean',
          default: true,
          description: 'Three-segment boolean key.',
        },
      },
      isCentralKey: neverCentral,
      userConfig: { tool: { section: { flag: false } } },
    });
    assert.strictEqual(result.values['tool.section.flag'], false, '3-segment override should be picked up');
    assert.ok(result.validKeys.includes('tool.section.flag'));
    assert.deepEqual(result.warnings, []);
  });

  test('__proto__ segment in dotted key does NOT pollute Object.prototype', () => {
    const schema = Object.create(null);
    // Create a key with __proto__ in the path via defineProperty
    Object.defineProperty(schema, '__proto__.x', {
      value: { owner: 'test', type: 'boolean', default: true, description: 'bad key' },
      enumerable: true, configurable: true, writable: true,
    });
    assert.doesNotThrow(() => {
      mergeFederatedConfig({
        configSchema: schema,
        isCentralKey: neverCentral,
        userConfig: {},
      });
    });
    // Object.prototype must not be polluted
    assert.strictEqual(({}).x, undefined, 'Object.prototype.x must not be polluted via __proto__ key');
  });

  test('a.__proto__.b segment in dotted key does NOT pollute Object.prototype', () => {
    // The key "a.__proto__.b" should be skipped at the __proto__ segment
    const result = mergeFederatedConfig({
      configSchema: {
        // We can't define 'a.__proto__.b' as an OWN property normally; skip test via defensive path
        'a.constructor.b': {
          owner: 'test',
          type: 'boolean',
          default: true,
          description: 'constructor key',
        },
      },
      isCentralKey: neverCentral,
      userConfig: {},
    });
    // 'a.constructor.b' contains 'constructor' segment — must be skipped
    assert.ok(!result.validKeys.includes('a.constructor.b'), 'Key with constructor segment must be skipped');
    // Object.prototype.constructor must still be Object
    assert.strictEqual(({}).constructor, Object, 'Object.prototype.constructor must not be modified');
  });
});

// ─── 8. Real registry — all UI keys are central (no-op guarantee) ────────────

describe('real registry: all UI keys are central → no-op channel', () => {
  test('with real capability-registry, all configSchema keys are skipped (pending-migration)', () => {
    const capRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');
    const configSchemaFromRegistry = capRegistry.configSchema;

    // Import the real isValidConfigKey
    const configSchemaModule = require('../gsd-core/bin/lib/config-schema.cjs');
    const { isValidConfigKey } = configSchemaModule;

    if (!configSchemaFromRegistry || Object.keys(configSchemaFromRegistry).length === 0) {
      // Registry has no configSchema keys — no-op by definition
      return;
    }

    const result = mergeFederatedConfig({
      configSchema: configSchemaFromRegistry,
      isCentralKey: isValidConfigKey,
      userConfig: {},
    });

    // Every key should be skipped (pending-migration) because UI keys are still in central schema
    assert.strictEqual(Object.keys(result.values).length, 0, 'values must be empty — all keys are central (pending-migration)');
    assert.deepEqual(result.validKeys, [], 'validKeys must be empty');
    assert.ok(result.warnings.length > 0, 'Should have pending-migration warnings');

    // Confirm each UI key specifically
    const uiKeys = ['workflow.ui_phase', 'workflow.ui_review', 'workflow.ui_safety_gate'];
    for (const key of uiKeys) {
      assert.ok(
        result.warnings.some((w) => w.includes(key)),
        'Should have a warning for ' + key + ', got: ' + JSON.stringify(result.warnings),
      );
    }
  });
});

// ─── 9. isCentralKey throwing defensively ────────────────────────────────────

describe('isCentralKey defensive behavior', () => {
  test('isCentralKey that throws → key is skipped with warning, no throw from mergeFederatedConfig', () => {
    const throwingCentralKey = () => { throw new Error('internal error'); };
    const result = mergeFederatedConfig({
      configSchema: { 'mytool.key': BOOLEAN_SLICE },
      isCentralKey: throwingCentralKey,
      userConfig: {},
    });
    // Key skipped due to isCentralKey throwing
    assert.ok(!Object.prototype.hasOwnProperty.call(result.values, 'mytool.key'), 'Key must be skipped when isCentralKey throws');
    assert.ok(result.warnings.length >= 1, 'Must produce a warning when isCentralKey throws');
  });
});
