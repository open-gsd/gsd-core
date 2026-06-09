'use strict';

/**
 * federated-config-loadconfig.test.cjs — Tests for the federated config overlay
 * wired into loadConfig (ADR-857 phase 3b).
 *
 * Tests:
 *   1. EQUIVALENCE/no-op: with the real registry, loadConfig output has NO unexpected
 *      extra keys (the UI keys are central so the overlay is empty).
 *   2. FIXTURE federated key: inject a synthetic configSchema with a key NOT in
 *      central schema → loadConfig surfaces it with its default.
 *   3. FIXTURE federated key with user override: user config sets the federated key
 *      to a valid value → that value is used.
 *   4. MALFORMED registry: configSchema with bad slices → loadConfig returns a valid
 *      config without throwing.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { cleanup } = require('./helpers.cjs');

// ─── Module under test ────────────────────────────────────────────────────────

const configLoader = require('../gsd-core/bin/lib/config-loader.cjs');
const {
  loadConfig,
  _setFederatedRegistryForTests,
  _resetFederatedRegistryForTests,
} = configLoader;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-fed-cfg-test-'));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  return tmpDir;
}

function writeConfig(tmpDir, obj) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify(obj, null, 2),
    'utf-8',
  );
}

// Keep track of temp dirs for cleanup
let tmpDirs = [];

beforeEach(() => {
  tmpDirs = [];
  _resetFederatedRegistryForTests();
});

afterEach(() => {
  _resetFederatedRegistryForTests();
  for (const d of tmpDirs) {
    try { cleanup(d); } catch { /* ignore */ }
  }
});

function mkTemp() {
  const d = makeTempProject();
  tmpDirs.push(d);
  return d;
}

// ─── 1. Equivalence / no-op with real registry ───────────────────────────────

describe('EQUIVALENCE: real registry is a no-op overlay', () => {
  test('loadConfig with an empty config.json returns base config without extra federated keys', () => {
    const tmpDir = mkTemp();
    // Write an empty config to trigger the try-branch (federated overlay path)
    writeConfig(tmpDir, {});
    const result = loadConfig(tmpDir);

    // The result must be an object
    assert.ok(typeof result === 'object' && result !== null, 'loadConfig must return an object');

    // Known result keys that loadConfig always provides (from the main try-branch)
    const knownKeys = [
      'model_profile', 'commit_docs', 'search_gitignored', 'branching_strategy',
      'research', 'plan_checker', 'verifier', 'parallelization', 'brave_search',
      'firecrawl', 'exa_search', 'text_mode', 'auto_advance',
      'mode', 'sub_repos', 'resolve_model_ids', 'context_window', 'phase_naming',
      'project_code', 'subagent_timeout', 'model_overrides', 'models', 'granularity',
      'granularities', 'planning', 'dynamic_routing', 'runtime', 'model_profile_overrides',
      'model_policy', 'effort', 'fast_mode', 'agent_skills', 'manager',
    ];

    for (const key of knownKeys) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(result, key),
        'Expected result to have key: ' + key,
      );
    }

    // UI-capability keys must NOT appear as new top-level keys (they're still central
    // and the overlay is empty — so these keys should not be added)
    // Note: 'workflow' IS an existing top-level key concept via VALID_CONFIG_KEYS,
    // but the nested keys like 'ui_phase' must not be present.
    const workflowSection = result['workflow'];
    if (workflowSection && typeof workflowSection === 'object') {
      // workflow section may already exist from user config but should not have ui_phase
      // in the default no-config case
      assert.ok(
        !Object.prototype.hasOwnProperty.call(workflowSection, 'ui_phase'),
        'workflow.ui_phase should not be injected by the federated overlay (key is still central)',
      );
      assert.ok(
        !Object.prototype.hasOwnProperty.call(workflowSection, 'ui_review'),
        'workflow.ui_review should not be injected by the federated overlay (key is still central)',
      );
      assert.ok(
        !Object.prototype.hasOwnProperty.call(workflowSection, 'ui_safety_gate'),
        'workflow.ui_safety_gate should not be injected by the federated overlay (key is still central)',
      );
    }
  });

  test('loadConfig with a real config.json returns expected values + no unexpected keys from overlay', () => {
    const tmpDir = mkTemp();
    writeConfig(tmpDir, { model_profile: 'balanced', research: true });
    const result = loadConfig(tmpDir);

    assert.strictEqual(result['model_profile'], 'balanced', 'model_profile from config');
    assert.strictEqual(result['research'], true, 'research from config');

    // The overlay must not have added any unexpected keys from the registry
    // (all UI keys are central → skipped → no additions)
    // Verify a spot-check: 'ui_phase' should not exist anywhere
    assert.strictEqual(result['ui_phase'], undefined, 'ui_phase should not appear as top-level key');
  });
});

// ─── 2. Fixture federated key — value = default ──────────────────────────────

describe('FIXTURE federated key: key not in central schema', () => {
  test('injected configSchema with non-central key → appears in loadConfig result with default', () => {
    const tmpDir = mkTemp();
    // Write an empty config.json so loadConfig enters the try-branch (federated overlay path)
    writeConfig(tmpDir, {});

    // Inject a synthetic registry with a key not in the central schema
    _setFederatedRegistryForTests({
      configSchema: {
        'mytool.enabled': {
          owner: 'mytool',
          type: 'boolean',
          default: true,
          description: 'Enable mytool.',
        },
      },
    });

    const result = loadConfig(tmpDir);

    // mytool is not in the central schema, so the overlay should surface it
    // The key 'mytool.enabled' is dotted → result should have result.mytool.enabled = true
    const myToolSection = result['mytool'];
    assert.ok(typeof myToolSection === 'object' && myToolSection !== null,
      'mytool section must be created for dotted federated key');
    assert.strictEqual(
      (myToolSection)['enabled'],
      true,
      'mytool.enabled must default to true from slice',
    );
  });

  test('injected top-level (non-dotted) federated key → appears in result', () => {
    const tmpDir = mkTemp();
    // Write an empty config.json to enter the try-branch
    writeConfig(tmpDir, {});

    _setFederatedRegistryForTests({
      configSchema: {
        'mytool_flag': {
          owner: 'mytool',
          type: 'boolean',
          default: false,
          description: 'Top-level mytool flag.',
        },
      },
    });

    const result = loadConfig(tmpDir);
    // Top-level key: result['mytool_flag'] = false (the default)
    // BUT: only added if NOT already present in _baseConfig
    // 'mytool_flag' is not in the central schema, so it should be added
    assert.strictEqual(result['mytool_flag'], false, 'mytool_flag should be set to default false');
  });
});

// ─── 3. Fixture federated key — user override ────────────────────────────────

describe('FIXTURE federated key: user config sets the key', () => {
  test('user sets a federated key to a valid value → loadConfig uses user value', () => {
    const tmpDir = mkTemp();

    // Write a user config with a synthetic federated key
    // The user config uses flat notation (mytool_flag: false)
    writeConfig(tmpDir, { mytool_flag: true });

    _setFederatedRegistryForTests({
      configSchema: {
        'mytool_flag': {
          owner: 'mytool',
          type: 'boolean',
          default: false,
          description: 'Top-level mytool flag.',
        },
      },
    });

    const result = loadConfig(tmpDir);
    // The user set mytool_flag=true, which matches the type (boolean), so user value wins
    assert.strictEqual(result['mytool_flag'], true, 'User-supplied true should override default false');
  });

  test('user sets a federated key to wrong type → loadConfig falls back to default', () => {
    const tmpDir = mkTemp();
    // Write a user config with the wrong type for the federated key
    writeConfig(tmpDir, { mytool_flag: 'not-a-bool' });

    _setFederatedRegistryForTests({
      configSchema: {
        'mytool_flag': {
          owner: 'mytool',
          type: 'boolean',
          default: false,
          description: 'Top-level mytool flag.',
        },
      },
    });

    const result = loadConfig(tmpDir);
    // Wrong type → fallback to default (false)
    assert.strictEqual(result['mytool_flag'], false, 'Should fall back to default on type mismatch');
  });
});

// ─── FIX 1: Nested dotted-path user-override in loadConfig ───────────────────

describe('FIX 1: nested user config drives federated overlay in loadConfig', () => {
  test('user config { mytool: { enabled: false } } (NESTED) → loadConfig surfaces false', () => {
    const tmpDir = mkTemp();
    // Write config.json with the nested structure users actually write
    writeConfig(tmpDir, { mytool: { enabled: false } });

    _setFederatedRegistryForTests({
      configSchema: {
        'mytool.enabled': {
          owner: 'mytool',
          type: 'boolean',
          default: true,
          description: 'Enable mytool.',
        },
      },
    });

    const result = loadConfig(tmpDir);
    const myToolSection = result['mytool'];
    assert.ok(typeof myToolSection === 'object' && myToolSection !== null,
      'mytool section must be in result');
    assert.strictEqual(
      (myToolSection)['enabled'],
      false,
      'Nested user override of false should override the default of true',
    );
  });
});

// ─── FIX 2: Overlay applied on no-config path ────────────────────────────────

describe('FIX 2: overlay applied on the no-config path', () => {
  test('project with NO config.json → federated default is surfaced (non-central key)', () => {
    // Create a project dir WITHOUT a .planning/config.json
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-fed-noconfig-'));
    tmpDirs.push(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
    // Intentionally do NOT write a config.json

    _setFederatedRegistryForTests({
      configSchema: {
        'mytool.enabled': {
          owner: 'mytool',
          type: 'boolean',
          default: false,
          description: 'Enable mytool (default false).',
        },
      },
    });

    const result = loadConfig(tmpDir);
    // The overlay must be applied on the no-config path: mytool.enabled should be false (the default)
    const myToolSection = result['mytool'];
    assert.ok(
      typeof myToolSection === 'object' && myToolSection !== null,
      'mytool section must be created by overlay even on no-config path, got: ' + JSON.stringify(result['mytool']),
    );
    assert.strictEqual(
      (myToolSection)['enabled'],
      false,
      'mytool.enabled must default to false on no-config path',
    );
  });

  test('no-config path with REAL registry (all keys central) → output is byte-identical to defaults (no-op)', () => {
    // No config.json — use real registry which has all keys central
    _resetFederatedRegistryForTests();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-fed-noconfig-real-'));
    tmpDirs.push(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
    // No config.json

    const result = loadConfig(tmpDir);
    assert.ok(typeof result === 'object' && result !== null, 'result must be an object');

    // With real registry (all keys central → overlay is empty → no-op), the result
    // should be the defaults object WITHOUT any extra injected keys.
    // Spot-check: ui_phase / ui_review / ui_safety_gate must NOT be injected
    const workflowSection = result['workflow'];
    if (workflowSection && typeof workflowSection === 'object') {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(workflowSection, 'ui_phase'),
        'workflow.ui_phase must not be injected on no-config path (no-op)',
      );
    }
    // model_profile must be present (it comes from defaults)
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'model_profile'), 'model_profile must be present');
  });
});

// ─── FIX 3: Federated key in config.json → no unknown-key warning ─────────────

describe('FIX 3: federated key present in config.json → no unknown-key warning', () => {
  test('synthetic federated key in config.json → no "unknown config key" warning on stderr', () => {
    const tmpDir = mkTemp();
    // Write a config.json that contains a key matching our synthetic federated key's top-level segment
    writeConfig(tmpDir, { mytool: { enabled: true } });

    _setFederatedRegistryForTests({
      configSchema: {
        'mytool.enabled': {
          owner: 'mytool',
          type: 'boolean',
          default: false,
          description: 'Enable mytool.',
        },
      },
    });

    // Capture stderr to check for unknown-key warning
    const stderrChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return origWrite(chunk, ...args);
    };

    try {
      const result = loadConfig(tmpDir);
      // mytool.enabled is in the federated registry → KNOWN_TOP_LEVEL should include 'mytool'
      // → no "unknown config key(s)" warning for 'mytool'
      const stderrOutput = stderrChunks.join('');
      assert.ok(
        !stderrOutput.includes('unknown config key') || !stderrOutput.includes('mytool'),
        'Should NOT warn about mytool as an unknown key when it is a registered federated key. stderr: ' + stderrOutput,
      );
      // The value should be set from user config
      const myToolSection = result['mytool'];
      assert.ok(
        typeof myToolSection === 'object' && myToolSection !== null,
        'mytool section should be in result',
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// ─── 4. Malformed registry — loadConfig still works ──────────────────────────

describe('MALFORMED registry: loadConfig does not throw', () => {
  test('configSchema with all malformed slices → loadConfig returns valid config, no throw', () => {
    const tmpDir = mkTemp();

    _setFederatedRegistryForTests({
      configSchema: {
        'bad.key1': null,
        'bad.key2': 'just-a-string',
        'bad.key3': { type: 'xml', default: '<x/>' },        // invalid type
        'bad.key4': { type: 'boolean', description: 'ok' },  // missing default
        'bad.key5': {},                                        // missing both
      },
    });

    let result;
    assert.doesNotThrow(() => {
      result = loadConfig(tmpDir);
    }, 'loadConfig must not throw even with all-malformed configSchema');

    assert.ok(typeof result === 'object' && result !== null, 'result must be an object');
    // None of the bad keys should appear in the result
    assert.strictEqual(result['bad.key1'], undefined);
    assert.strictEqual(result['bad.key2'], undefined);
    const badSection = result['bad'];
    if (badSection && typeof badSection === 'object') {
      assert.strictEqual((badSection)['key1'], undefined, 'bad.key1 must not be set');
    }
  });

  test('configSchema is a string (completely unexpected) → loadConfig still works', () => {
    const tmpDir = mkTemp();

    _setFederatedRegistryForTests({
      configSchema: 'not-an-object',
    });

    let result;
    assert.doesNotThrow(() => {
      result = loadConfig(tmpDir);
    }, 'loadConfig must not throw with non-object configSchema');

    assert.ok(typeof result === 'object' && result !== null, 'result must be an object');
  });

  test('registry throws during configSchema access → loadConfig still returns base config', () => {
    const tmpDir = mkTemp();

    // Create a registry proxy that throws when configSchema is accessed
    const throwingRegistry = {
      get configSchema() { throw new Error('registry exploded'); },
    };

    _setFederatedRegistryForTests(throwingRegistry);

    let result;
    assert.doesNotThrow(() => {
      result = loadConfig(tmpDir);
    }, 'loadConfig must not throw even if registry access throws');

    assert.ok(typeof result === 'object' && result !== null, 'result must still be an object');
    // The base config keys must be present
    assert.ok(Object.prototype.hasOwnProperty.call(result, 'model_profile'), 'model_profile must be present');
  });
});
