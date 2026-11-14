'use strict';

/**
 * #3703 — under `resolve_model_ids: "omit"`, a runtime whose descriptor declares
 * `hostBehaviors.nativeModelAliases` receives the profile's TIER ALIAS as the
 * model, instead of the empty string. Every other runtime keeps the blank (and
 * the #2517 omit-`model=` rule), because there a tier alias fails the spawn.
 *
 * Acceptance (maintainer decision on #3703, 2026-11-08):
 *   1. Under project omit on Claude, every spawn site receives the profile's tier,
 *      whether or not CLAUDE_CODE_SUBAGENT_MODEL is set.
 *   2. On a runtime without tier aliases, spawns keep omitting `model=` (blank).
 *   3. Default (non-omit) output is unchanged.
 *   4. `--pick tier` output is unchanged.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, cleanup } = require('./helpers.cjs');

const {
  resolveModelInternal,
  resolveTierInternal,
  _resetInstallRuntimeMarkerCacheForTests,
} = require('../gsd-core/bin/lib/model-resolver.cjs');
const { MODEL_PROFILES, RUNTIME_PROFILE_MAP, VALID_PROFILES, AGENT_TO_PHASE_TYPE } =
  require('../gsd-core/bin/lib/model-catalog.cjs');
const { hostBehaviorsFor } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const { runtimes: REGISTRY_RUNTIMES } = require('../gsd-core/bin/lib/capability-registry.cjs');

const AGENTS = Object.keys(MODEL_PROFILES);
const ALIAS_TIERS = new Set(['opus', 'sonnet', 'haiku']);
const NATIVE = Object.keys(REGISTRY_RUNTIMES).filter((r) => hostBehaviorsFor(r).nativeModelAliases === true);
const NON_NATIVE_NO_MAP = Object.keys(REGISTRY_RUNTIMES)
  .filter((r) => hostBehaviorsFor(r).nativeModelAliases !== true && !Object.hasOwn(RUNTIME_PROFILE_MAP, r));

const ENV_KEYS = ['GSD_RUNTIME', 'GSD_HOME', 'HOME', 'USERPROFILE', 'GSD_WORKSTREAM', 'GSD_PROJECT', 'CLAUDE_CODE_SUBAGENT_MODEL'];

function mkProject(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3703-'));
  fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
  writeProjectConfig(dir, config);
  return dir;
}

function writeProjectConfig(dir, config) {
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(config));
}

// In-process resolution with the runtime declared EXPLICITLY (never inherited
// from the shell that ran the suite) and HOME/GSD_HOME redirected into the
// project so a developer's ~/.gsd/defaults.json cannot change an expected value.
function withEnv(dir, runtime, extra, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.GSD_HOME = dir;
    process.env.GSD_RUNTIME = runtime;
    Object.assign(process.env, extra);
    _resetInstallRuntimeMarkerCacheForTests();
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetInstallRuntimeMarkerCacheForTests();
  }
}

function resolveIn(dir, agent, runtime, extra = {}) {
  return withEnv(dir, runtime, extra, () => resolveModelInternal(dir, agent));
}

function cli(dir, args, env = {}) {
  const r = runGsdTools(args, dir, { HOME: dir, USERPROFILE: dir, GSD_HOME: dir, GSD_RUNTIME: 'claude', CLAUDE_CODE_SUBAGENT_MODEL: '', ...env });
  assert.ok(r.success, `${args} failed: ${r.error}`);
  return r.output;
}

describe('#3703: project omit on a native-alias runtime resolves the tier alias', () => {
  let dir;
  beforeEach(() => { dir = null; });
  afterEach(() => { if (dir) cleanup(dir); });

  test('the registry declares at least one native-alias runtime and one without a tier map', () => {
    // Guards the parity rows below against passing vacuously over an empty set.
    assert.ok(NATIVE.length > 0, 'no runtime declares hostBehaviors.nativeModelAliases');
    assert.ok(NON_NATIVE_NO_MAP.length > 0, 'every non-native runtime has a tier map');
  });

  for (const profile of ['quality', 'balanced', 'budget']) {
    test(`every profiled agent gets its tier alias (profile ${profile}, claude)`, () => {
      dir = mkProject({ model_profile: profile, resolve_model_ids: 'omit' });
      for (const agent of AGENTS) {
        const tier = withEnv(dir, 'claude', {}, () => resolveTierInternal(dir, agent));
        assert.ok(ALIAS_TIERS.has(tier), `${agent}: expected an alias tier, got ${tier}`);
        assert.strictEqual(resolveIn(dir, agent, 'claude'), tier, `${agent} under ${profile}`);
      }
    });
  }

  test('no runtime declared anywhere resolves as claude and gets the alias', () => {
    dir = mkProject({ model_profile: 'balanced', resolve_model_ids: 'omit' });
    assert.strictEqual(resolveIn(dir, 'gsd-planner', ''), 'opus');
    assert.strictEqual(resolveIn(dir, 'gsd-codebase-mapper', ''), 'haiku');
  });

  test('a models.<phase_type> tier wins over the profile tier', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit', models: { research: 'haiku' } });
    assert.strictEqual(resolveIn(dir, 'gsd-phase-researcher', 'claude'), 'haiku');
  });

  test('CLAUDE_CODE_SUBAGENT_MODEL does not change the resolved alias', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit' });
    const without = resolveIn(dir, 'gsd-planner', 'claude');
    const withEnvVar = resolveIn(dir, 'gsd-planner', 'claude', { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });
    assert.strictEqual(without, 'opus');
    assert.strictEqual(withEnvVar, 'opus');
  });

  test('model_profile inherit stays blank under omit', () => {
    dir = mkProject({ model_profile: 'inherit', resolve_model_ids: 'omit' });
    assert.strictEqual(resolveIn(dir, 'gsd-planner', 'claude'), '');
  });

  test('an unknown agent has no tier and stays blank under omit', () => {
    dir = mkProject({ model_profile: 'balanced', resolve_model_ids: 'omit' });
    assert.strictEqual(resolveIn(dir, 'not-a-real-gsd-agent', 'claude'), '');
  });

  test('a model_profile_overrides.claude pin does not outrank the omit alias', () => {
    dir = mkProject({
      model_profile: 'balanced',
      resolve_model_ids: 'omit',
      model_profile_overrides: { claude: { opus: 'claude-opus-4-7' } },
    });
    assert.strictEqual(resolveIn(dir, 'gsd-planner', 'claude'), 'opus');
  });

  test('dynamic_routing.tier_models does not outrank the omit alias', () => {
    dir = mkProject({
      model_profile: 'quality',
      resolve_model_ids: 'omit',
      dynamic_routing: { enabled: true, tier_models: { light: 'haiku', standard: 'DR-STANDARD', heavy: 'DR-HEAVY' } },
    });
    assert.strictEqual(resolveIn(dir, 'gsd-planner', 'claude'), 'opus');
  });

  test('model_overrides still wins under omit', () => {
    dir = mkProject({ model_profile: 'balanced', resolve_model_ids: 'omit', model_overrides: { 'gsd-planner': 'haiku' } });
    assert.strictEqual(resolveIn(dir, 'gsd-planner', 'claude'), 'haiku');
  });
});

describe('#3703: runtimes without native aliases keep the blank', () => {
  let dir;
  afterEach(() => { if (dir) cleanup(dir); dir = null; });

  test('every non-native runtime without a tier map resolves "" under project omit', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit' });
    for (const runtime of NON_NATIVE_NO_MAP) {
      for (const agent of ['gsd-planner', 'gsd-executor', 'gsd-codebase-mapper']) {
        assert.strictEqual(resolveIn(dir, agent, runtime), '', `${runtime}/${agent}`);
      }
    }
  });

  test('descriptor parity: the alias appears iff the runtime declares nativeModelAliases', () => {
    dir = mkProject({ model_profile: 'balanced', resolve_model_ids: 'omit' });
    for (const runtime of Object.keys(REGISTRY_RUNTIMES)) {
      const model = resolveIn(dir, 'gsd-planner', runtime);
      if (NATIVE.includes(runtime)) {
        assert.strictEqual(model, 'opus', `${runtime} declares native aliases`);
      } else if (Object.hasOwn(RUNTIME_PROFILE_MAP, runtime)) {
        // #4717: a detected runtime with a tier map resolves its own map (step 3).
        assert.strictEqual(model, RUNTIME_PROFILE_MAP[runtime].opus.model, `${runtime} tier map`);
      } else {
        assert.strictEqual(model, '', `${runtime} has neither native aliases nor a tier map`);
      }
    }
  });

  test('an unrecognised runtime label is not native and stays blank', () => {
    dir = mkProject({ model_profile: 'balanced', resolve_model_ids: 'omit' });
    assert.strictEqual(resolveIn(dir, 'gsd-planner', 'not-a-real-runtime'), '');
  });
});

describe('#3703: default output and --pick tier are unchanged', () => {
  let dir;
  afterEach(() => { if (dir) cleanup(dir); dir = null; });

  for (const value of [undefined, false, true]) {
    test(`resolve_model_ids ${String(value)}: the omit change does not reach this path`, () => {
      const cfg = { model_profile: 'balanced' };
      if (value !== undefined) cfg.resolve_model_ids = value;
      dir = mkProject(cfg);
      const expected = value === true ? 'claude-opus-4-8' : 'opus';
      assert.strictEqual(resolveIn(dir, 'gsd-planner', 'claude'), expected);
    });
  }

  test('--pick tier is identical with and without omit', () => {
    dir = mkProject({ model_profile: 'quality' });
    const before = cli(dir, 'query resolve-model gsd-codebase-mapper --pick tier').trim();
    writeProjectConfig(dir, { model_profile: 'quality', resolve_model_ids: 'omit' });
    const after = cli(dir, 'query resolve-model gsd-codebase-mapper --pick tier').trim();
    assert.strictEqual(before, 'sonnet');
    assert.strictEqual(after, before);
  });
});

describe('#3703: spawn-site payloads carry the alias (the issue reproduction)', () => {
  let dir;
  afterEach(() => { if (dir) cleanup(dir); dir = null; });

  test('resolve-model JSON under project omit reports model === tier', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit' });
    const parsed = JSON.parse(cli(dir, 'query resolve-model gsd-codebase-mapper'));
    assert.strictEqual(parsed.tier, 'sonnet');
    assert.strictEqual(parsed.model, 'sonnet');
  });

  test('resolve-model --pick model is the alias even with CLAUDE_CODE_SUBAGENT_MODEL set', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit' });
    const model = cli(dir, 'query resolve-model gsd-planner --pick model', { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }).trim();
    assert.strictEqual(model, 'opus');
  });

  test('init quick binds the alias into executor_model / planner_model', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit' });
    const payload = JSON.parse(cli(dir, 'init quick --raw'));
    assert.strictEqual(payload.executor_model, withEnv(dir, 'claude', {}, () => resolveTierInternal(dir, 'gsd-executor')));
    assert.strictEqual(payload.planner_model, 'opus');
  });

  test('a non-native runtime without a tier map still binds "" in the init payload', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit' });
    const payload = JSON.parse(cli(dir, 'init quick --raw', { GSD_RUNTIME: NON_NATIVE_NO_MAP[0] }));
    assert.strictEqual(payload.executor_model, '');
  });
});

describe('#3703: property — under omit on a native runtime, model equals the alias tier', () => {
  let dir;
  beforeEach(() => { dir = mkProject({}); });
  afterEach(() => { cleanup(dir); });

  test('fc: model === tier when tier is an alias, else ""', () => {
    const phaseTypes = [...new Set(Object.values(AGENT_TO_PHASE_TYPE))];
    fc.assert(fc.property(
      fc.constantFrom(...VALID_PROFILES),
      fc.constantFrom(...AGENTS),
      fc.option(fc.record({ phase: fc.constantFrom(...phaseTypes), tier: fc.constantFrom('opus', 'sonnet', 'haiku', 'inherit') }), { nil: null }),
      fc.constantFrom(...NATIVE),
      (profile, agent, phaseOverride, runtime) => {
        const cfg = { model_profile: profile, resolve_model_ids: 'omit' };
        if (phaseOverride) cfg.models = { [phaseOverride.phase]: phaseOverride.tier };
        writeProjectConfig(dir, cfg);
        const tier = withEnv(dir, runtime, {}, () => resolveTierInternal(dir, agent));
        const model = resolveIn(dir, agent, runtime);
        assert.strictEqual(model, ALIAS_TIERS.has(tier) ? tier : '');
      },
    ));
  });
});
