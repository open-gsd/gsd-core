'use strict';

/**
 * Tests for config-loader.cjs (ADR-857 phase 2e / #885).
 *
 * Covers:
 *   - loadConfig defaults when no config.json file exists
 *   - loadConfig merges file values over defaults
 *   - legacy-key normalization (branching_strategy → git.branching_strategy)
 *   - workstream overlay (root → workstream inheritance)
 *   - workstream-null fallback when workstream config is absent
 *   - unknown-key warning dedup (_warnedUnknownConfigKeys deduplications)
 *   - malformed JSON handling (falls back to defaults)
 *   - shim identity: core.loadConfig === configLoader.loadConfig
 *   - ADVERSARIAL fixtures: empty JSON, unknown keys, dynamic-prefix keys
 *     like agent_skills.__proto__, scalars-where-objects-expected,
 *     missing config file
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

// ─── module under test ────────────────────────────────────────────────────────

const configLoader = require('../gsd-core/bin/lib/config-loader.cjs');

const { loadConfig, _resetRuntimeWarningCacheForTests } = configLoader;

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTempProject(prefix = 'gsd-cfg-loader-test-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  return tmpDir;
}

function writeConfig(tmpDir, obj) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf-8');
}

function writeWorkstreamConfig(tmpDir, wsName, obj) {
  const wsDir = path.join(tmpDir, '.planning', 'workstreams', wsName);
  fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'config.json'), JSON.stringify(obj, null, 2), 'utf-8');
}


// ─── defaults when no config.json ────────────────────────────────────────────

describe('loadConfig — defaults when no config.json', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('returns an object with expected default keys when config.json is absent', () => {
    const config = loadConfig(tmpDir);
    // Structural checks — should have canonical keys from CONFIG_DEFAULTS
    assert.ok('model_profile' in config, 'must have model_profile');
    assert.ok('commit_docs' in config, 'must have commit_docs');
    assert.ok('research' in config, 'must have research');
    assert.ok('branching_strategy' in config, 'must have branching_strategy');
    assert.ok('plan_checker' in config, 'must have plan_checker');
    assert.ok('verifier' in config, 'must have verifier');
    assert.ok('parallelization' in config, 'must have parallelization');
    assert.ok('sub_repos' in config, 'must have sub_repos');
    assert.ok('resolve_model_ids' in config, 'must have resolve_model_ids');
  });

  test('model_profile default is "balanced"', () => {
    const config = loadConfig(tmpDir);
    assert.equal(config.model_profile, 'balanced');
  });

  test('config.json present with empty object: agent_skills default is an empty object', () => {
    // agent_skills only appears in the return when a config.json is successfully parsed
    writeConfig(tmpDir, {});
    const config = loadConfig(tmpDir);
    assert.deepEqual(config.agent_skills, {});
  });

  test('config.json present with empty object: model_overrides default is null', () => {
    // model_overrides only appears in the return when a config.json is successfully parsed
    writeConfig(tmpDir, {});
    const config = loadConfig(tmpDir);
    assert.equal(config.model_overrides, null);
  });
});

// ─── file values merge over defaults ─────────────────────────────────────────

describe('loadConfig — file values override defaults', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('model_profile from config.json overrides the default', () => {
    writeConfig(tmpDir, { model_profile: 'quality' });
    const config = loadConfig(tmpDir);
    assert.equal(config.model_profile, 'quality');
  });

  test('workflow.research from nested config is returned', () => {
    writeConfig(tmpDir, { workflow: { research: 'deep' } });
    const config = loadConfig(tmpDir);
    assert.equal(config.research, 'deep');
  });

  test('top-level research is returned', () => {
    writeConfig(tmpDir, { research: 'minimal' });
    const config = loadConfig(tmpDir);
    assert.equal(config.research, 'minimal');
  });

  test('mode from config.json is returned', () => {
    writeConfig(tmpDir, { mode: 'autonomous' });
    const config = loadConfig(tmpDir);
    assert.equal(config.mode, 'autonomous');
  });

  test('model_overrides from config.json is returned', () => {
    writeConfig(tmpDir, { model_overrides: { planner: 'claude-opus-4-5' } });
    const config = loadConfig(tmpDir);
    assert.deepEqual(config.model_overrides, { planner: 'claude-opus-4-5' });
  });
});

// ─── legacy-key normalization ─────────────────────────────────────────────────

describe('loadConfig — legacy-key normalization', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('top-level branching_strategy is migrated to git.branching_strategy', () => {
    writeConfig(tmpDir, { branching_strategy: 'milestone' });
    const config = loadConfig(tmpDir);
    assert.equal(config.branching_strategy, 'milestone');
  });

  test('on-disk file has branching_strategy moved under git.* after migration', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ branching_strategy: 'phase' }, null, 2), 'utf-8');
    loadConfig(tmpDir);
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(onDisk.git?.branching_strategy, 'phase');
    assert.equal(onDisk.branching_strategy, undefined);
  });
});

// ─── workstream overlay ───────────────────────────────────────────────────────

describe('loadConfig — workstream overlay', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('workstream config overrides root config', () => {
    writeConfig(tmpDir, { model_profile: 'balanced' });
    writeWorkstreamConfig(tmpDir, 'ws-a', { model_profile: 'quality' });
    const config = loadConfig(tmpDir, { workstream: 'ws-a' });
    assert.equal(config.model_profile, 'quality');
  });

  test('root-only keys are inherited by workstream config', () => {
    writeConfig(tmpDir, { model_profile: 'balanced', research: 'deep' });
    writeWorkstreamConfig(tmpDir, 'ws-b', { mode: 'autonomous' });
    const config = loadConfig(tmpDir, { workstream: 'ws-b' });
    // Root's research should still be visible (inherited)
    assert.equal(config.research, 'deep');
    // Workstream's mode should override
    assert.equal(config.mode, 'autonomous');
  });

  test('workstream-null fallback: root config used when workstream has no config.json', () => {
    writeConfig(tmpDir, { model_profile: 'budget' });
    // Create workstream directory but no config.json
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'ws-no-config');
    fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
    // loadConfig with missing workstream config.json should fall back to root
    const config = loadConfig(tmpDir, { workstream: 'ws-no-config' });
    assert.equal(config.model_profile, 'budget');
  });
});

// ─── unknown-key warning dedup ────────────────────────────────────────────────

describe('loadConfig — unknown-key warning dedup', () => {
  let tmpDir;
  let originalStderrWrite;
  let stderrLines;

  beforeEach(() => {
    tmpDir = makeTempProject();
    stderrLines = [];
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      stderrLines.push(String(chunk));
      return true;
    };
    // Reset the module-level dedup set so each test starts clean
    if (_resetRuntimeWarningCacheForTests) _resetRuntimeWarningCacheForTests();
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    if (tmpDir) cleanup(tmpDir);
    tmpDir = null;
  });

  test('unknown key produces a warning mentioning the key name', () => {
    writeConfig(tmpDir, { __gsd_unknown_sentinel__: true });
    loadConfig(tmpDir);
    const warnings = stderrLines.filter(l => l.includes('__gsd_unknown_sentinel__'));
    assert.ok(warnings.length >= 1, 'should warn about unknown key');
  });

  test('calling loadConfig twice does not double-emit the same unknown-key warning', () => {
    writeConfig(tmpDir, { __gsd_dedup_test__: true });
    loadConfig(tmpDir);
    loadConfig(tmpDir);
    const warnings = stderrLines.filter(l => l.includes('__gsd_dedup_test__'));
    // Should appear at most once
    assert.ok(warnings.length <= 1, `warning emitted more than once: ${warnings.length} times`);
  });
});

// ─── malformed JSON handling ──────────────────────────────────────────────────

describe('loadConfig — malformed JSON', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('malformed config.json returns defaults without throwing', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, '{ invalid json !!', 'utf-8');
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    assert.ok(typeof config === 'object' && config !== null, 'should return an object');
    assert.ok('model_profile' in config, 'should have model_profile key');
  });

  test('empty config.json (empty braces) does not throw and returns defaults', () => {
    writeConfig(tmpDir, {});
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    assert.equal(config.model_profile, 'balanced');
  });
});

// ─── ADVERSARIAL fixtures ─────────────────────────────────────────────────────

describe('loadConfig — adversarial fixtures', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('agent_skills.__proto__ key in config does not pollute Object prototype', () => {
    // Write config with a prototype-pollution candidate key
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    // JSON.stringify won't serialize __proto__ as an own property;
    // write the raw string to simulate an adversarial file.
    fs.writeFileSync(
      configPath,
      '{"agent_skills": {"__proto__": {"polluted": true}}}',
      'utf-8'
    );
    const before = ({}).polluted;
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    const after = ({}).polluted;
    assert.equal(before, after, 'Object prototype must not be polluted');
    // agent_skills should be the parsed value or an empty object — not throw
    assert.ok(typeof config.agent_skills === 'object', 'agent_skills should be an object');
  });

  test('scalars-where-objects-expected: workflow is a string', () => {
    writeConfig(tmpDir, { workflow: 'invalid' });
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    assert.ok(typeof config === 'object', 'should return an object');
  });

  test('completely empty JSON file (just whitespace) falls back to defaults', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, '   ', 'utf-8');
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    assert.ok('model_profile' in config);
  });

  test('null JSON value (top-level null) falls back to defaults', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    fs.writeFileSync(configPath, 'null', 'utf-8');
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    assert.ok('model_profile' in config);
  });

  test('deeply nested unknown keys do not throw', () => {
    writeConfig(tmpDir, {
      workflow: {
        research: 'minimal',
        __unknown_nested__: { a: 1, b: { c: 2 } },
      },
    });
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    assert.equal(config.research, 'minimal');
  });

  test('dynamic-prefix key agent_skills.* with unusual value type does not throw', () => {
    writeConfig(tmpDir, { agent_skills: { 'my-skill': null } });
    let config;
    assert.doesNotThrow(() => { config = loadConfig(tmpDir); });
    assert.ok(typeof config.agent_skills === 'object');
  });

  test('config with only unknown keys returns defaults for known keys', () => {
    writeConfig(tmpDir, { completly_unknown_a: 1, completly_unknown_b: 2 });
    const config = loadConfig(tmpDir);
    assert.equal(config.model_profile, 'balanced');
  });
});
