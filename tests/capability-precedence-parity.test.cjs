'use strict';
/**
 * capability-precedence-parity.test.cjs — DEFECT.GENERATIVE-FIX parity gate
 *
 * Proves that the config-key four-level precedence walk has a single owner
 * (capability-activation.cjs) and that loop-resolver.cjs re-exports the same
 * functions rather than maintaining local copies.
 *
 * Two contracts enforced:
 *   (a) Identity: loop-resolver's _resolveActivationValue, _getNestedConfigValue,
 *       and _readRawConfigKey are the SAME function objects as
 *       capability-activation's exports. Fails the instant a local copy is
 *       re-introduced.
 *   (b) Behavioral matrix: across a fixture matrix hitting each precedence level
 *       (loadConfig result, workstream config.json, root config.json, registry
 *       default, absent, falsy values, prototype-pollution key), asserts that
 *       _resolveActivationValue(key,config,cwd,registry) ===
 *       (resolveConfigKey(key,{config,cwd,registry}).found ?
 *        Boolean(resolveConfigKey(key,{config,cwd,registry}).value) : false).
 *       Level-2/3 cases use real tmpdir .planning/config.json fixtures.
 *
 * RULESET: RULESET.TESTS.no-source-grep — no readFileSync + .includes() on source.
 * RULESET: RULESET.TESTS.boundary-coverage — covers limit-1/limit/limit+1 (falsy boundary).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

// ── Module paths ──────────────────────────────────────────────────────────────

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');

const capabilityActivation = require(path.join(LIB, 'capability-activation.cjs'));
const loopResolver = require(path.join(LIB, 'loop-resolver.cjs'));

// ─── (a) Identity guard ───────────────────────────────────────────────────────

describe('capability-precedence-parity: identity guard — loop-resolver re-exports same function objects', () => {
  test('_resolveActivationValue is the same function in both modules', () => {
    assert.strictEqual(
      loopResolver._resolveActivationValue,
      capabilityActivation._resolveActivationValue,
      '_resolveActivationValue: loop-resolver must re-export the capability-activation.cjs function, not a local copy',
    );
  });

  test('_getNestedConfigValue is the same function in both modules', () => {
    assert.strictEqual(
      loopResolver._getNestedConfigValue,
      capabilityActivation._getNestedConfigValue,
      '_getNestedConfigValue: loop-resolver must re-export the capability-activation.cjs function, not a local copy',
    );
  });

  test('_readRawConfigKey is the same function in both modules', () => {
    assert.strictEqual(
      loopResolver._readRawConfigKey,
      capabilityActivation._readRawConfigKey,
      '_readRawConfigKey: loop-resolver must re-export the capability-activation.cjs function, not a local copy',
    );
  });
});

// ─── (b) Behavioral matrix ────────────────────────────────────────────────────

/**
 * Build a minimal registry with a configSchema entry for a dotted key.
 * def=undefined means no default (absent). def=<value> provides a default.
 */
function makeRegistry(dotKey, def) {
  const registry = {};
  if (def !== undefined) {
    registry.configSchema = {
      [dotKey]: { default: def },
    };
  } else {
    registry.configSchema = {};
  }
  return registry;
}

/**
 * Helper: call resolveConfigKey and assert it equals
 * _resolveActivationValue(key,config,cwd,registry) on the boolean coercion.
 */
function assertParity(key, config, cwd, registry, label) {
  const { _resolveActivationValue, resolveConfigKey } = capabilityActivation;
  const boolResult = _resolveActivationValue(key, config, cwd, registry);
  const rawResult = resolveConfigKey(key, { config, cwd, registry });
  const expectedBool = rawResult.found ? Boolean(rawResult.value) : false;
  assert.strictEqual(
    boolResult,
    expectedBool,
    `parity check failed for ${label}: _resolveActivationValue=${boolResult} but resolveConfigKey gives found=${rawResult.found} value=${JSON.stringify(rawResult.value)} → expectedBool=${expectedBool}`,
  );
  return { boolResult, rawResult };
}

describe('capability-precedence-parity: behavioral matrix', () => {
  let tmpDir;

  before(() => {
    // Create a hermetic tmpdir for file-based fixtures (levels 2+3).
    // Clear env vars that redirect planningDir/planningRoot.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-'));
  });

  after(() => {
    // Remove the tmpdir (helpers.cleanup carries the Windows-EBUSY retry budget).
    cleanup(tmpDir);
  });

  // Env vars that planningDir/planningRoot read — save/restore around each test.
  function withCleanEnv(fn) {
    const saved = {
      GSD_WORKSTREAM: process.env.GSD_WORKSTREAM,
      GSD_PROJECT: process.env.GSD_PROJECT,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    };
    delete process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      return fn();
    } finally {
      if (saved.GSD_WORKSTREAM !== undefined) process.env.GSD_WORKSTREAM = saved.GSD_WORKSTREAM;
      else delete process.env.GSD_WORKSTREAM;
      if (saved.GSD_PROJECT !== undefined) process.env.GSD_PROJECT = saved.GSD_PROJECT;
      else delete process.env.GSD_PROJECT;
      if (saved.CLAUDE_CONFIG_DIR !== undefined) process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
      else delete process.env.CLAUDE_CONFIG_DIR;
    }
  }

  // ── Level 1: loadConfig result (config arg has the key) ─────────────────────

  test('level-1 truthy: config arg has key=true → resolved true, parity holds', () => {
    const key = 'feature.enabled';
    const config = { feature: { enabled: true } };
    const registry = makeRegistry(key, undefined);
    const { boolResult, rawResult } = assertParity(key, config, undefined, registry, 'level-1 truthy');
    assert.strictEqual(boolResult, true);
    assert.strictEqual(rawResult.found, true);
    assert.strictEqual(rawResult.value, true);
  });

  test('level-1 falsy (false): config arg has key=false → resolved false, parity holds', () => {
    // BVA: falsy value false — boundary case
    const key = 'feature.enabled';
    const config = { feature: { enabled: false } };
    const registry = makeRegistry(key, true); // default true but level-1 wins
    const { boolResult, rawResult } = assertParity(key, config, undefined, registry, 'level-1 falsy=false');
    assert.strictEqual(boolResult, false);
    assert.strictEqual(rawResult.found, true);
    assert.strictEqual(rawResult.value, false); // raw value preserved
  });

  test('level-1 falsy (0): config arg has key=0 → resolved false, parity holds', () => {
    // BVA: falsy value 0 — boundary case
    const key = 'feature.level';
    const config = { feature: { level: 0 } };
    const registry = makeRegistry(key, 2); // default 2 but level-1 wins
    const { boolResult, rawResult } = assertParity(key, config, undefined, registry, 'level-1 falsy=0');
    assert.strictEqual(boolResult, false);
    assert.strictEqual(rawResult.found, true);
    assert.strictEqual(rawResult.value, 0); // raw value 0 preserved
  });

  test('level-1 truthy (nonzero): config arg has key=2 → resolved true, parity holds', () => {
    // BVA: truthy numeric — boundary-adjacent to 0
    const key = 'feature.level';
    const config = { feature: { level: 2 } };
    const registry = makeRegistry(key, undefined);
    const { boolResult, rawResult } = assertParity(key, config, undefined, registry, 'level-1 truthy=2');
    assert.strictEqual(boolResult, true);
    assert.strictEqual(rawResult.found, true);
    assert.strictEqual(rawResult.value, 2);
  });

  // ── Level 2: workstream config.json ─────────────────────────────────────────

  test('level-2: workstream config.json has key → resolved, level-1 empty, parity holds', () => {
    withCleanEnv(() => {
      // Set up a .planning/config.json in tmpDir
      const planningDir = path.join(tmpDir, 'ws-l2', '.planning');
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(
        path.join(planningDir, 'config.json'),
        JSON.stringify({ graphify: { enabled: true } }),
        'utf8',
      );
      const key = 'graphify.enabled';
      const config = {}; // level-1 miss
      const registry = makeRegistry(key, undefined);
      const cwd = path.join(tmpDir, 'ws-l2');
      const { boolResult, rawResult } = assertParity(key, config, cwd, registry, 'level-2 workstream');
      assert.strictEqual(boolResult, true);
      assert.strictEqual(rawResult.found, true);
      assert.strictEqual(rawResult.value, true);
    });
  });

  test('level-2 falsy: workstream config.json has key=false → false, parity holds', () => {
    withCleanEnv(() => {
      const planningDir = path.join(tmpDir, 'ws-l2-false', '.planning');
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(
        path.join(planningDir, 'config.json'),
        JSON.stringify({ graphify: { enabled: false } }),
        'utf8',
      );
      const key = 'graphify.enabled';
      const config = {};
      const registry = makeRegistry(key, true); // default true, but level-2 wins
      const cwd = path.join(tmpDir, 'ws-l2-false');
      const { boolResult, rawResult } = assertParity(key, config, cwd, registry, 'level-2 falsy');
      assert.strictEqual(boolResult, false);
      assert.strictEqual(rawResult.found, true);
      assert.strictEqual(rawResult.value, false);
    });
  });

  // ── Level 3: root config.json (only when paths differ) ──────────────────────

  // Without GSD_WORKSTREAM, planningDir === planningRoot, so levels 2 and 3 point
  // to the same file. Level-3 distinction is only exercisable by setting GSD_WORKSTREAM.
  // We test the "paths same → no double-read" path (covered by level-2 test above)
  // and the "paths differ" path via GSD_WORKSTREAM.
  test('level-3: root config.json read when workstream path differs, parity holds', () => {
    // Use GSD_WORKSTREAM to force planningDir to differ from planningRoot.
    withCleanEnv(() => {
      const projectRoot = path.join(tmpDir, 'ws-l3-project');
      // Root planning dir = projectRoot/.planning
      const rootPlanningDir = path.join(projectRoot, '.planning');
      // Workstream planning dir = projectRoot/.planning/workstreams/mystream
      const wsName = 'mystream';
      const wsPlanningDir = path.join(rootPlanningDir, 'workstreams', wsName);
      fs.mkdirSync(rootPlanningDir, { recursive: true });
      fs.mkdirSync(wsPlanningDir, { recursive: true });

      // Write ONLY the root config.json (no ws config.json)
      fs.writeFileSync(
        path.join(rootPlanningDir, 'config.json'),
        JSON.stringify({ intel: { enabled: true } }),
        'utf8',
      );

      // Activate workstream so planningDir → wsPlanningDir, planningRoot → rootPlanningDir
      process.env.GSD_WORKSTREAM = wsName;

      const key = 'intel.enabled';
      const config = {};
      const registry = makeRegistry(key, undefined);
      const { boolResult, rawResult } = assertParity(key, config, projectRoot, registry, 'level-3 root config');
      // ws config.json absent → level-2 miss; root config.json present → level-3 hit
      assert.strictEqual(boolResult, true);
      assert.strictEqual(rawResult.found, true);
      assert.strictEqual(rawResult.value, true);
    });
  });

  // ── Level 4: registry configSchema default ───────────────────────────────────

  test('level-4: registry default=true, no config or file → true, parity holds', () => {
    withCleanEnv(() => {
      const key = 'workflow.some_feature';
      const config = {};
      const registry = makeRegistry(key, true);
      // cwd points to an empty dir — no .planning/config.json files
      const cwd = path.join(tmpDir, 'l4-default-true');
      fs.mkdirSync(cwd, { recursive: true });
      const { boolResult, rawResult } = assertParity(key, config, cwd, registry, 'level-4 default=true');
      assert.strictEqual(boolResult, true);
      assert.strictEqual(rawResult.found, true);
      assert.strictEqual(rawResult.value, true);
    });
  });

  test('level-4: registry default=false → false (BVA: falsy default), parity holds', () => {
    withCleanEnv(() => {
      const key = 'workflow.some_feature';
      const config = {};
      const registry = makeRegistry(key, false);
      const cwd = path.join(tmpDir, 'l4-default-false');
      fs.mkdirSync(cwd, { recursive: true });
      const { boolResult, rawResult } = assertParity(key, config, cwd, registry, 'level-4 default=false');
      assert.strictEqual(boolResult, false);
      assert.strictEqual(rawResult.found, true);
      assert.strictEqual(rawResult.value, false); // raw false preserved
    });
  });

  test('level-4: registry default=0 → false (BVA: numeric zero default), parity holds', () => {
    withCleanEnv(() => {
      const key = 'feature.level';
      const config = {};
      const registry = makeRegistry(key, 0);
      const cwd = path.join(tmpDir, 'l4-default-0');
      fs.mkdirSync(cwd, { recursive: true });
      const { boolResult, rawResult } = assertParity(key, config, cwd, registry, 'level-4 default=0');
      assert.strictEqual(boolResult, false);
      assert.strictEqual(rawResult.found, true);
      assert.strictEqual(rawResult.value, 0); // raw 0 preserved
    });
  });

  // ── Level 5: absent ──────────────────────────────────────────────────────────

  test('level-5: key absent everywhere → false, found=false, parity holds', () => {
    withCleanEnv(() => {
      const key = 'nonexistent.key';
      const config = {};
      const registry = makeRegistry(key, undefined); // no default
      const cwd = path.join(tmpDir, 'l5-absent');
      fs.mkdirSync(cwd, { recursive: true });
      const { boolResult, rawResult } = assertParity(key, config, cwd, registry, 'level-5 absent');
      assert.strictEqual(boolResult, false);
      assert.strictEqual(rawResult.found, false);
      assert.strictEqual(rawResult.value, undefined);
    });
  });

  test('level-5: cwd=undefined, absent key → false, found=false, parity holds', () => {
    const key = 'nonexistent.key';
    const config = {};
    const registry = makeRegistry(key, undefined);
    const { boolResult, rawResult } = assertParity(key, config, undefined, registry, 'level-5 absent cwd=undefined');
    assert.strictEqual(boolResult, false);
    assert.strictEqual(rawResult.found, false);
  });

  // ── Prototype-pollution guard (nested-traversal sink, levels 1–3) ──────────────
  //
  // The guard protects the NESTED config-object traversal (_getNestedConfigValue) —
  // the only prototype-pollution sink. A `__proto__`/`constructor`/`prototype`
  // SEGMENT encountered mid-path is rejected → found=false. Level 4 is a flat
  // single-key lookup of the whole dotted string against registry.configSchema (no
  // nested traversal, not a pollution sink), so we deliberately seed NO level-4
  // default here — otherwise that flat lookup would legitimately match the literal
  // dotted key and the segment guard would not be the thing under test.

  test('prototype-pollution: __proto__ mid-path segment → found=false, boolResult=false, parity holds', () => {
    const key = 'a.__proto__.polluted';
    const config = { a: { real: 1 } }; // 'a' resolves, then the '__proto__' segment must be rejected
    const registry = makeRegistry(key, undefined); // no level-4 default
    const { boolResult, rawResult } = assertParity(key, config, undefined, registry, 'proto-pollution __proto__ mid-path');
    assert.strictEqual(rawResult.found, false, '__proto__ path segment must be rejected by the nested-traversal guard');
    assert.strictEqual(boolResult, false);
  });

  test('prototype-pollution: constructor mid-path segment → found=false, boolResult=false, parity holds', () => {
    const key = 'a.constructor.polluted';
    const config = { a: { real: 1 } };
    const registry = makeRegistry(key, undefined); // no level-4 default
    const { boolResult, rawResult } = assertParity(key, config, undefined, registry, 'proto-pollution constructor mid-path');
    assert.strictEqual(rawResult.found, false, 'constructor path segment must be rejected by the nested-traversal guard');
    assert.strictEqual(boolResult, false);
  });

  // ── Level-1 precedence over level-4 ─────────────────────────────────────────

  test('level-1 wins over level-4 default: config=false beats registry default=true', () => {
    // BVA: this is the critical boundary — level-1 falsy beats level-4 truthy
    const key = 'graphify.enabled';
    const config = { graphify: { enabled: false } };
    const registry = makeRegistry(key, true);
    const { boolResult, rawResult } = assertParity(key, config, undefined, registry, 'level-1 false beats level-4 true default');
    assert.strictEqual(boolResult, false, 'config value false must win over registry default true');
    assert.strictEqual(rawResult.found, true);
    assert.strictEqual(rawResult.value, false);
  });
});

// ─── (c) resolveConfigKey identity guard (FIX 2 — loop-resolver re-exports resolveConfigKey) ────
//
// resolveLoopHooks.resolveConfigValues uses resolveConfigKey internally to build
// hook configValues. Exporting resolveConfigKey from loop-resolver and asserting
// identity here ensures that if someone ever introduces a local copy, this test
// will catch it immediately (same mechanism as the _resolveActivationValue guard
// above, applied to the raw-value consumer).

describe('capability-precedence-parity: identity guard — loop-resolver.resolveConfigKey is same fn as capability-activation.resolveConfigKey', () => {
  test('resolveConfigKey is the same function in both modules', () => {
    assert.ok(
      typeof loopResolver.resolveConfigKey === 'function',
      'loop-resolver must export resolveConfigKey',
    );
    assert.strictEqual(
      loopResolver.resolveConfigKey,
      capabilityActivation.resolveConfigKey,
      'resolveConfigKey: loop-resolver must re-export the capability-activation.cjs function, not a local copy',
    );
  });
});

// ─── (d) Behavioral: loop-resolver resolveConfigValues uses the shared engine ────────────────────
//
// Proves that resolveLoopHooks's resolveConfigValues closure (the RAW-value consumer)
// produces the SAME result as calling capabilityActivation.resolveConfigKey directly
// for the same (dotKey, config, cwd, registry) arguments.
//
// This test FAILS if resolveConfigValues is ever replaced with a divergent copy that
// does not delegate to resolveConfigKey — fulfilling the DEFECT.GENERATIVE-FIX mandate.
//
// Coverage: three cases required:
//   (1) Level-1 config hit       — key present in config arg
//   (2) Level-4 registry default — key absent from config, present in schema default
//   (3) Absent key               — key absent everywhere (omitted from resolved output)

describe('capability-precedence-parity: behavioral — loop-resolver resolveConfigValues uses shared resolveConfigKey engine', () => {
  const { resolveLoopHooks } = loopResolver;
  const { resolveConfigKey } = capabilityActivation;
  const { CANONICAL_POINTS_FALLBACK } = loopResolver;

  /**
   * Build a minimal registry that has:
   *  - one contribution hook at the given point with configValues map
   *  - one capability that owns that hook (capId = 'test-cap', active=true implied)
   *  - configSchema entries for level-4 defaults
   */
  function makeLoopRegistry({ point, configValues, schemaDefaults = {} }) {
    const byLoopPoint = {};
    for (const p of CANONICAL_POINTS_FALLBACK) {
      byLoopPoint[p] = { steps: [], contributions: [], gates: [] };
    }
    byLoopPoint[point].contributions = [
      {
        capId: 'test-cap',
        into: 'test-section',
        fragment: { inline: 'test fragment' },
        configValues,
      },
    ];
    const configSchema = {};
    for (const [dotKey, def] of Object.entries(schemaDefaults)) {
      configSchema[dotKey] = { default: def };
    }
    return { byLoopPoint, configSchema };
  }

  /** capabilityStatesById with test-cap active=true */
  function activeCapMap() {
    return new Map([['test-cap', { enabled: true, active: true }]]);
  }

  test('(1) level-1 config hit: resolveConfigValues matches resolveConfigKey for present key', () => {
    // Hook declares configValues: { secLevel: 'security.asvs_level' }
    // Config has security.asvs_level=2 → level-1 hit
    const dotKey = 'security.asvs_level';
    const alias = 'secLevel';
    const config = { security: { asvs_level: 2 } };
    const registry = makeLoopRegistry({
      point: 'plan:pre',
      configValues: { [alias]: dotKey },
    });

    const resolved = resolveLoopHooks({
      point: 'plan:pre',
      registry,
      config,
      cwd: undefined,
      capabilityStatesById: activeCapMap(),
    });

    assert.strictEqual(resolved.activeHooks.length, 1, 'One active contribution hook expected');
    const hook = resolved.activeHooks[0];
    assert.ok(hook.configValues, 'configValues must be present on the resolved hook');

    // resolveConfigKey direct result for the same args
    const directResult = resolveConfigKey(dotKey, { config, cwd: undefined, registry });
    assert.strictEqual(directResult.found, true, 'direct resolveConfigKey must find the level-1 key');
    assert.strictEqual(
      hook.configValues[alias],
      directResult.value,
      `resolved hook configValues[${alias}] must equal resolveConfigKey(...).value for level-1 hit (both=${JSON.stringify(directResult.value)})`,
    );
    assert.strictEqual(hook.configValues[alias], 2, 'level-1 numeric value 2 must be preserved (not coerced to boolean)');
  });

  test('(2) level-4 registry default hit: resolveConfigValues matches resolveConfigKey for schema default', () => {
    // Hook declares configValues: { blockOn: 'security.block_on' }
    // Config is empty; schema default = 'medium'
    const dotKey = 'security.block_on';
    const alias = 'blockOn';
    const schemaDefault = 'medium';
    const config = {};
    const registry = makeLoopRegistry({
      point: 'execute:pre',
      configValues: { [alias]: dotKey },
      schemaDefaults: { [dotKey]: schemaDefault },
    });

    const resolved = resolveLoopHooks({
      point: 'execute:pre',
      registry,
      config,
      cwd: undefined,
      capabilityStatesById: activeCapMap(),
    });

    assert.strictEqual(resolved.activeHooks.length, 1, 'One active contribution hook expected');
    const hook = resolved.activeHooks[0];
    assert.ok(hook.configValues, 'configValues must be present on the resolved hook (schema default found)');

    const directResult = resolveConfigKey(dotKey, { config, cwd: undefined, registry });
    assert.strictEqual(directResult.found, true, 'direct resolveConfigKey must find the level-4 schema default');
    assert.strictEqual(
      hook.configValues[alias],
      directResult.value,
      `resolved hook configValues[${alias}] must equal resolveConfigKey(...).value for level-4 hit (both=${JSON.stringify(directResult.value)})`,
    );
    assert.strictEqual(hook.configValues[alias], 'medium', 'level-4 string default must be preserved as raw string');
  });

  test('(3a) mixed hook: one resolvable alias + one absent alias → configValues present, contains only the resolvable alias', () => {
    // Hook declares configValues: { present: 'feature.on', absent: 'nope.missing' }
    // Config has feature.on=true (level-1 hit); no registry default for nope.missing.
    // Expected: resolved hook.configValues is defined, has 'present'=true, does NOT have 'absent'.
    const presentDotKey = 'feature.on';
    const absentDotKey = 'nope.missing';
    const config = { feature: { on: true } };
    const registry = makeLoopRegistry({
      point: 'verify:post',
      configValues: { present: presentDotKey, absent: absentDotKey },
      // No schema default for absentDotKey — it must be absent everywhere
    });

    const resolved = resolveLoopHooks({
      point: 'verify:post',
      registry,
      config,
      cwd: undefined,
      capabilityStatesById: activeCapMap(),
    });

    assert.strictEqual(resolved.activeHooks.length, 1, 'One active contribution hook expected');
    const hook = resolved.activeHooks[0];

    // The 'present' alias must resolve via level-1 config hit
    assert.ok(hook.configValues !== undefined, 'configValues must be defined (at least one alias resolved)');
    assert.strictEqual(
      hook.configValues['present'],
      true,
      "hook.configValues['present'] must equal true (level-1 hit for feature.on)",
    );

    // The 'absent' alias must NOT appear in configValues at all (omit-when-absent contract)
    assert.ok(
      !Object.prototype.hasOwnProperty.call(hook.configValues, 'absent'),
      "Absent key 'nope.missing' must not appear in hook.configValues (found=false → omit, not include as undefined)",
    );
  });

  test('(3b) all-absent hook: all configValues aliases absent everywhere → hook.configValues === undefined', () => {
    // Hook declares configValues: { missingAlias: 'does.not.exist' }
    // Key absent from config, no schema default, no config files.
    // resolveConfigValues must return undefined (empty resolved map → omitted entirely).
    const dotKey = 'does.not.exist';
    const alias = 'missingAlias';
    const config = {};
    const registry = makeLoopRegistry({
      point: 'ship:pre',
      configValues: { [alias]: dotKey },
      // No schema default for this key
    });

    const resolved = resolveLoopHooks({
      point: 'ship:pre',
      registry,
      config,
      cwd: undefined,
      capabilityStatesById: activeCapMap(),
    });

    assert.strictEqual(resolved.activeHooks.length, 1, 'One active contribution hook expected');
    const hook = resolved.activeHooks[0];

    // resolveConfigKey direct result must confirm absent
    const directResult = resolveConfigKey(dotKey, { config, cwd: undefined, registry });
    assert.strictEqual(directResult.found, false, 'resolveConfigKey must return found=false for absent key');
    assert.strictEqual(directResult.value, undefined);

    // When ALL aliases are absent, resolveConfigValues returns undefined → hook.configValues must be undefined
    assert.strictEqual(
      hook.configValues,
      undefined,
      'hook.configValues must be undefined when all aliases are absent (omit-when-empty contract)',
    );
  });
});
