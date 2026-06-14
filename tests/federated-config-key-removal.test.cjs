'use strict';

/**
 * federated-config-key-removal.test.cjs
 *
 * ADR-857 deliverable F — Decision 3:
 *   "Uninstalling a Capability removes its config keys cleanly."
 *
 * Tests:
 *   [happy]  Capability X present → its key surfaces; X removed → key gone, others intact.
 *   [happy]  loadConfig after removing a capability no longer surfaces the key, but central
 *            base-config keys remain.
 *   [BVA]    Orphaned user value for the removed key is dropped — not leaked as a phantom key.
 *   [negative] Removing capability 'x' does NOT drop a differently-prefixed capability's key
 *              (e.g. 'xy.enabled' survives when only 'x.enabled' is removed).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { cleanup } = require('./helpers.cjs');

const { mergeFederatedConfig } = require('../gsd-core/bin/lib/federated-config.cjs');

const configLoader = require('../gsd-core/bin/lib/config-loader.cjs');
const {
  loadConfig,
  _setFederatedRegistryForTests,
  _resetFederatedRegistryForTests,
} = configLoader;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Never treated as a central key — all keys federated freely. */
const neverCentral = (_key) => false;

/** Minimal well-formed boolean slice. */
function boolSlice(owner, defaultValue = true) {
  return { owner, type: 'boolean', default: defaultValue, description: `Boolean key for ${owner}.` };
}

// ─── Temp project helpers (mirrors federated-config-loadconfig.test.cjs) ──────

let tmpDirs = [];

beforeEach(() => {
  tmpDirs = [];
  _resetFederatedRegistryForTests();
});

afterEach(() => {
  _resetFederatedRegistryForTests();
  for (const d of tmpDirs) {
    cleanup(d);
  }
});

function mkTempProject() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cap-removal-test-'));
  tmpDirs.push(d);
  fs.mkdirSync(path.join(d, '.planning', 'phases'), { recursive: true });
  return d;
}

function writeConfig(dir, obj) {
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(obj, null, 2),
    'utf-8',
  );
}

// ─── 1. [happy] key present → surfaces; capability removed → key gone ─────────

describe('[happy] capability X present then removed — key lifecycle', () => {
  test('registry WITH capability X: x.enabled surfaces with default true', () => {
    const withX = {
      'x.enabled': boolSlice('cap-x', true),
    };

    const result = mergeFederatedConfig({
      configSchema: withX,
      isCentralKey: neverCentral,
      userConfig: {},
    });

    // Positive assertion: the key is in validKeys AND values
    assert.ok(
      result.validKeys.includes('x.enabled'),
      'x.enabled must be in validKeys when cap-x is installed',
    );
    assert.strictEqual(
      result.values['x.enabled'],
      true,
      'x.enabled default must be true',
    );
    assert.deepEqual(result.warnings, [], 'no warnings for valid federated key');
  });

  test('registry WITHOUT capability X: x.enabled is absent from result', () => {
    // Registry after cap-x is uninstalled — its key is no longer in configSchema
    const withoutX = {};

    const result = mergeFederatedConfig({
      configSchema: withoutX,
      isCentralKey: neverCentral,
      userConfig: {},
    });

    assert.ok(
      !result.validKeys.includes('x.enabled'),
      'x.enabled must NOT be in validKeys after cap-x is removed',
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(result.values, 'x.enabled'),
      'x.enabled must NOT appear in values after cap-x is removed',
    );
    assert.strictEqual(Object.keys(result.values).length, 0, 'values must be empty');
  });

  test('[no contamination] removing cap-x leaves cap-y.flag intact', () => {
    // Before removal: both capabilities present
    const withBoth = {
      'x.enabled': boolSlice('cap-x', true),
      'y.flag': boolSlice('cap-y', false),
    };

    const before = mergeFederatedConfig({
      configSchema: withBoth,
      isCentralKey: neverCentral,
      userConfig: {},
    });

    assert.ok(before.validKeys.includes('x.enabled'), 'x.enabled present before removal');
    assert.ok(before.validKeys.includes('y.flag'), 'y.flag present before removal');

    // After removal: only cap-y remains in the registry
    const withoutX = {
      'y.flag': boolSlice('cap-y', false),
    };

    const after = mergeFederatedConfig({
      configSchema: withoutX,
      isCentralKey: neverCentral,
      userConfig: {},
    });

    // x.enabled must be gone
    assert.ok(
      !after.validKeys.includes('x.enabled'),
      'x.enabled must be absent after cap-x removal',
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(after.values, 'x.enabled'),
      'x.enabled must not appear in values after removal',
    );

    // y.flag must still be present AND have the correct value
    assert.ok(
      after.validKeys.includes('y.flag'),
      'y.flag must still be in validKeys after cap-x removal',
    );
    assert.strictEqual(
      after.values['y.flag'],
      false,
      'y.flag value must remain false (its default) after cap-x removal',
    );
  });
});

// ─── 2. [happy] loadConfig: removed capability key absent, base keys intact ───

describe('[happy] loadConfig after capability removal — base keys survive', () => {
  test('cap-x present → loadConfig surfaces mytool.enabled; cap-x absent → key gone', () => {
    const tmpDir = mkTempProject();
    writeConfig(tmpDir, {});

    // Phase A: cap-x installed
    _setFederatedRegistryForTests({
      configSchema: {
        'mytool.enabled': boolSlice('cap-x', true),
      },
    });

    const resultWith = loadConfig(tmpDir);
    assert.ok(
      typeof resultWith['mytool'] === 'object' && resultWith['mytool'] !== null,
      'mytool section must exist when cap-x is installed',
    );
    assert.strictEqual(
      resultWith['mytool']['enabled'],
      true,
      'mytool.enabled must be true (cap-x default)',
    );

    // Phase B: cap-x uninstalled — registry now empty
    _resetFederatedRegistryForTests();
    _setFederatedRegistryForTests({ configSchema: {} });

    const resultWithout = loadConfig(tmpDir);
    // Central base-config key must still be present
    assert.ok(
      Object.prototype.hasOwnProperty.call(resultWithout, 'model_profile'),
      'model_profile (central key) must still exist after cap-x removal',
    );
    // Federated key must be absent — either undefined or not surfaced under 'mytool'
    const myToolSection = resultWithout['mytool'];
    const enabledValue = (myToolSection && typeof myToolSection === 'object')
      ? myToolSection['enabled']
      : undefined;
    assert.strictEqual(
      enabledValue,
      undefined,
      'mytool.enabled must NOT be present after cap-x removal; got: ' + JSON.stringify(enabledValue),
    );
  });

  test('base config keys (model_profile, research) survive capability removal', () => {
    const tmpDir = mkTempProject();
    writeConfig(tmpDir, { model_profile: 'fast', research: false });

    // Install and then remove a synthetic capability
    _setFederatedRegistryForTests({
      configSchema: {
        'extra.flag': boolSlice('cap-extra', true),
      },
    });
    const before = loadConfig(tmpDir);
    assert.strictEqual(before['model_profile'], 'fast', 'model_profile from user config before removal');
    assert.strictEqual(before['research'], false, 'research from user config before removal');

    _setFederatedRegistryForTests({ configSchema: {} });
    const after = loadConfig(tmpDir);

    // Central keys from user's config.json must be unchanged
    assert.strictEqual(after['model_profile'], 'fast', 'model_profile must survive capability removal');
    assert.strictEqual(after['research'], false, 'research must survive capability removal');
  });
});

// ─── 3. [BVA] orphaned user value not surfaced after removal ──────────────────

describe('[BVA] orphaned user value is silently dropped after capability removal', () => {
  test('user config sets removed key → orphaned value not surfaced as phantom', () => {
    // User has 'mytool.enabled': false in their config.json
    // BUT the capability is now uninstalled (not in registry configSchema)
    const result = mergeFederatedConfig({
      configSchema: {},          // cap-x removed — configSchema is empty
      isCentralKey: neverCentral,
      userConfig: { mytool: { enabled: false } },  // user value remains in file
    });

    // The orphaned user value must NOT leak into validKeys or values
    assert.ok(
      !result.validKeys.includes('mytool.enabled'),
      'orphaned user key must not appear in validKeys',
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(result.values, 'mytool.enabled'),
      'orphaned user key must not appear in values',
    );
    // The entire values map must be empty (no phantom keys)
    assert.strictEqual(
      Object.keys(result.values).length,
      0,
      'values must be empty when registry has no keys — got: ' + JSON.stringify(Object.keys(result.values)),
    );
    assert.deepEqual(result.validKeys, [], 'validKeys must be empty when registry has no keys');
  });

  test('user config sets removed key — top-level orphan also not surfaced', () => {
    // Top-level orphan: user set 'orphan_flag' but the cap is gone
    const result = mergeFederatedConfig({
      configSchema: {},
      isCentralKey: neverCentral,
      userConfig: { orphan_flag: true },
    });

    assert.ok(
      !Object.prototype.hasOwnProperty.call(result.values, 'orphan_flag'),
      'top-level orphaned key must not appear in values',
    );
    assert.deepEqual(result.validKeys, []);
    assert.strictEqual(Object.keys(result.values).length, 0);
  });

  test('loadConfig: orphaned user value in config.json not surfaced after removal', () => {
    const tmpDir = mkTempProject();
    // User config contains a value for a key whose capability will be removed
    writeConfig(tmpDir, { orphancap: { flag: true } });

    // Capability removed: inject empty registry
    _setFederatedRegistryForTests({ configSchema: {} });

    const result = loadConfig(tmpDir);

    // The orphaned capability key must NOT be surfaced in the resolved config object.
    // loadConfig extracts only known/central/federated keys into _baseConfig — any key
    // whose capability has been uninstalled (configSchema: {}) must not appear in the result.
    assert.ok(
      !Object.prototype.hasOwnProperty.call(result, 'orphancap'),
      'orphaned top-level key must not appear in resolved config when capability is removed',
    );
    // Central keys must remain unaffected by capability removal.
    assert.ok(
      Object.prototype.hasOwnProperty.call(result, 'model_profile'),
      'model_profile must still be present (central key unaffected by federated removal)',
    );
  });
});

// ─── 4. [negative] removing 'x' does NOT drop 'xy.enabled' ──────────────────

describe('[negative] prefix-adjacent key not dropped when shorter-prefix cap removed', () => {
  test("removing cap 'x' (key x.enabled) does NOT remove cap 'xy' (key xy.enabled)", () => {
    // Registry after 'x' is uninstalled but 'xy' remains
    const registryAfterXRemoved = {
      'xy.enabled': boolSlice('cap-xy', false),
    };

    const result = mergeFederatedConfig({
      configSchema: registryAfterXRemoved,
      isCentralKey: neverCentral,
      userConfig: {},
    });

    // x.enabled must not appear (was removed)
    assert.ok(
      !result.validKeys.includes('x.enabled'),
      'x.enabled must not appear (cap-x was uninstalled)',
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(result.values, 'x.enabled'),
      'x.enabled must not be in values',
    );

    // xy.enabled MUST still appear (different capability)
    assert.ok(
      result.validKeys.includes('xy.enabled'),
      'xy.enabled must still be present after cap-x removal',
    );
    assert.strictEqual(
      result.values['xy.enabled'],
      false,
      'xy.enabled value must be false (cap-xy default), not contaminated by cap-x removal',
    );
  });

  test("removing 'x' does not drop 'x2.enabled' (numeric suffix, distinct cap)", () => {
    const registryAfterXRemoved = {
      'x2.enabled': boolSlice('cap-x2', true),
    };

    const result = mergeFederatedConfig({
      configSchema: registryAfterXRemoved,
      isCentralKey: neverCentral,
      userConfig: {},
    });

    assert.ok(
      !result.validKeys.includes('x.enabled'),
      'x.enabled must not appear (not in registry)',
    );
    assert.ok(
      result.validKeys.includes('x2.enabled'),
      'x2.enabled must survive — it belongs to cap-x2, not cap-x',
    );
    assert.strictEqual(
      result.values['x2.enabled'],
      true,
      'x2.enabled must have its own default (true)',
    );
  });

  test("removing 'alpha' cap does not affect 'alphabeta.flag' cap", () => {
    const registryAfterAlphaRemoved = {
      'alphabeta.flag': boolSlice('cap-alphabeta', false),
      'gamma.flag': boolSlice('cap-gamma', true),
    };

    const result = mergeFederatedConfig({
      configSchema: registryAfterAlphaRemoved,
      isCentralKey: neverCentral,
      userConfig: {},
    });

    // alpha.flag not present (removed)
    assert.ok(
      !result.validKeys.includes('alpha.flag'),
      'alpha.flag must not appear after cap-alpha removal',
    );

    // alphabeta.flag MUST be present (distinct capability)
    assert.ok(
      result.validKeys.includes('alphabeta.flag'),
      'alphabeta.flag must survive removal of alpha capability',
    );
    assert.strictEqual(
      result.values['alphabeta.flag'],
      false,
      'alphabeta.flag value must be false (its own default)',
    );

    // gamma.flag also unaffected
    assert.ok(
      result.validKeys.includes('gamma.flag'),
      'gamma.flag must be unaffected by alpha removal',
    );
    assert.strictEqual(
      result.values['gamma.flag'],
      true,
      'gamma.flag value must be true (its own default)',
    );
  });
});
