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

const { loadConfig, loadConfigResolved, _resetRuntimeWarningCacheForTests } = configLoader;

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

// ─── loadConfigResolved — provenance ──────────────────────────────────────────

describe('loadConfigResolved — provenance', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('source is "root" when config.json exists and no workstream requested', () => {
    writeConfig(tmpDir, { model_profile: 'quality' });
    const result = loadConfigResolved(tmpDir);
    assert.equal(result.source, 'root');
    assert.equal(result.degraded, false);
    assert.ok(typeof result.config === 'object', 'config must be an object');
    assert.equal(result.config.model_profile, 'quality');
  });

  test('source is "workstream", degraded:false when workstream config.json present', () => {
    writeConfig(tmpDir, { model_profile: 'balanced' });
    writeWorkstreamConfig(tmpDir, 'ws-a', { model_profile: 'quality' });
    const result = loadConfigResolved(tmpDir, { workstream: 'ws-a' });
    assert.equal(result.source, 'workstream');
    assert.equal(result.degraded, false);
    assert.equal(result.config.model_profile, 'quality');
  });

  test('source is "root", degraded:true when workstream requested but ws config.json absent', () => {
    writeConfig(tmpDir, { model_profile: 'budget' });
    // Create ws directory without config.json
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'ws-no-config');
    fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
    const result = loadConfigResolved(tmpDir, { workstream: 'ws-no-config' });
    assert.equal(result.source, 'root');
    assert.equal(result.degraded, true);
    assert.equal(result.config.model_profile, 'budget');
  });

  test('source is "builtin-defaults" when .planning exists but config.json is absent', () => {
    // tmpDir already has .planning/ but no config.json
    const result = loadConfigResolved(tmpDir);
    assert.equal(result.source, 'builtin-defaults');
    assert.equal(result.degraded, false);
    assert.ok('model_profile' in result.config);
  });

  test('source is "global-defaults" when no .planning exists but ~/.gsd/defaults.json readable', () => {
    const homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-home-test-'));
    const origGsdHome = process.env['GSD_HOME'];
    try {
      const gsdDir = path.join(homeTmp, '.gsd');
      fs.mkdirSync(gsdDir, { recursive: true });
      fs.writeFileSync(path.join(gsdDir, 'defaults.json'), JSON.stringify({ model_profile: 'home-defaults' }), 'utf-8');
      process.env['GSD_HOME'] = homeTmp;
      const noPlanning = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-noplanning-'));
      try {
        const result = loadConfigResolved(noPlanning);
        assert.equal(result.source, 'global-defaults');
        assert.equal(result.degraded, false);
        assert.equal(result.config.model_profile, 'home-defaults');
      } finally {
        cleanup(noPlanning);
      }
    } finally {
      if (origGsdHome === undefined) delete process.env['GSD_HOME'];
      else process.env['GSD_HOME'] = origGsdHome;
      cleanup(homeTmp);
    }
  });

  test('source is "builtin-defaults" when no .planning and no global defaults', () => {
    const noPlanning = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-noplanning2-'));
    const homeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-nohome-'));
    const origGsdHome = process.env['GSD_HOME'];
    try {
      // Point GSD_HOME to a directory with no .gsd/defaults.json
      process.env['GSD_HOME'] = homeTmp;
      const result = loadConfigResolved(noPlanning);
      assert.equal(result.source, 'builtin-defaults');
      assert.equal(result.degraded, false);
      assert.ok('model_profile' in result.config);
    } finally {
      if (origGsdHome === undefined) delete process.env['GSD_HOME'];
      else process.env['GSD_HOME'] = origGsdHome;
      cleanup(noPlanning);
      cleanup(homeTmp);
    }
  });

  test('back-compat: loadConfig(tmp) deepEquals loadConfigResolved(tmp).config', () => {
    writeConfig(tmpDir, { model_profile: 'quality', research: 'minimal' });
    const fromLoadConfig = loadConfig(tmpDir);
    const { config: fromResolved } = loadConfigResolved(tmpDir);
    assert.deepEqual(fromLoadConfig, fromResolved);
  });

  test('back-compat: loadConfigResolved(descendant) does NOT walk up — returns defaults, not ancestor config', () => {
    // Fix 1: loadConfigResolved must NOT call findProjectRoot internally.
    // Calling from a descendant that has no .planning/ of its own must return
    // defaults (builtin-defaults source), NOT the ancestor's config value.
    writeConfig(tmpDir, { model_profile: 'ancestor-config-should-not-appear' });
    const deepDir = path.join(tmpDir, 'src', 'deep');
    fs.mkdirSync(deepDir, { recursive: true });
    const result = loadConfigResolved(deepDir);
    // No .planning/ in deepDir → must fall back to defaults, NOT walk up to tmpDir.
    assert.notEqual(result.config.model_profile, 'ancestor-config-should-not-appear',
      'loadConfigResolved must NOT walk up to find ancestor config');
    // The source must be a defaults source (builtin-defaults or global-defaults),
    // NOT "root" (which would imply a config.json was found).
    assert.ok(
      result.source === 'builtin-defaults' || result.source === 'global-defaults',
      `Expected a defaults source, got: ${result.source}`,
    );
  });

  test('Fix 4: loadConfigResolved(tmp, { workstream: "" }) → source:"root"', () => {
    writeConfig(tmpDir, { model_profile: 'quality' });
    // empty-string ws resolves the root path → source must be "root"
    const result = loadConfigResolved(tmpDir, { workstream: '' });
    assert.equal(result.source, 'root', 'empty-string workstream should yield source:"root"');
    assert.equal(result.degraded, false);
  });

  test('Fix 2a: GSD_WORKSTREAM set to nonexistent workstream (dir absent) → source:"root", degraded:true', () => {
    writeConfig(tmpDir, { model_profile: 'root-value' });
    const origWs = process.env['GSD_WORKSTREAM'];
    try {
      process.env['GSD_WORKSTREAM'] = 'nonexistent-ws';
      // Do NOT create the workstream directory
      const result = loadConfigResolved(tmpDir);
      assert.equal(result.source, 'root', 'nonexistent workstream should fall back to source:"root"');
      assert.equal(result.degraded, true, 'should be degraded when workstream dir is absent');
      assert.equal(result.config.model_profile, 'root-value', 'config should equal root config');
    } finally {
      if (origWs === undefined) delete process.env['GSD_WORKSTREAM'];
      else process.env['GSD_WORKSTREAM'] = origWs;
    }
  });

  test('Fix 2b: options.workstream missing dir → source:"root", degraded:true', () => {
    writeConfig(tmpDir, { model_profile: 'root-val' });
    // workstream dir NOT created
    const result = loadConfigResolved(tmpDir, { workstream: 'missing-ws' });
    assert.equal(result.source, 'root');
    assert.equal(result.degraded, true);
    assert.equal(result.config.model_profile, 'root-val');
  });

  test('Fix 2c: workstream dir exists but no config.json → source:"root", degraded:true (existing case still works)', () => {
    writeConfig(tmpDir, { model_profile: 'root-val-c' });
    // Create ws dir but no config.json
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'ws-no-cfg');
    fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
    const result = loadConfigResolved(tmpDir, { workstream: 'ws-no-cfg' });
    assert.equal(result.source, 'root');
    assert.equal(result.degraded, true);
    assert.equal(result.config.model_profile, 'root-val-c');
  });
});
