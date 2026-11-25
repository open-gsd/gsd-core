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
const { isolatedEnv } = require('./helpers/isolated-env.cjs');

const {
  resolveModelInternal,
  resolveModelForTier,
  resolveProviderEscalation,
  resolveTierInternal,
  _resetInstallRuntimeMarkerCacheForTests,
} = require('../gsd-core/bin/lib/model-resolver.cjs');
const { MODEL_PROFILES, RUNTIME_PROFILE_MAP, VALID_PROFILES, AGENT_TO_PHASE_TYPE, VALID_TIERS, catalog } =
  require('../gsd-core/bin/lib/model-catalog.cjs');
const { AGENT_DEFAULT_TIERS, nextTier } = require('../gsd-core/bin/lib/model-profiles.cjs');
const { loadConfig } = require('../gsd-core/bin/lib/config-loader.cjs');
const { hostBehaviorsFor } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const { runtimes: REGISTRY_RUNTIMES } = require('../gsd-core/bin/lib/capability-registry.cjs');

const AGENTS = Object.keys(MODEL_PROFILES);
const ALIAS_TIERS = new Set([...VALID_TIERS].filter((t) => t !== 'inherit'));
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

function tierIn(dir, agent, runtime) {
  return withEnv(dir, runtime, {}, () => resolveTierInternal(dir, agent));
}

function resolveForTierIn(dir, agent, runtime, attempt) {
  return withEnv(dir, runtime, {}, () => resolveModelForTier(dir, agent, attempt));
}

function cli(dir, args, env = {}) {
  const r = runGsdTools(args, dir, isolatedEnv({ home: dir, override: { GSD_HOME: dir, GSD_RUNTIME: 'claude', CLAUDE_CODE_SUBAGENT_MODEL: '', ...env } }));
  assert.ok(r.success, `${args} failed: ${r.error}`);
  return r.output;
}

describe('#3703: project omit on a native-alias runtime resolves the tier alias', () => {
  let dir;
  afterEach(() => { if (dir) cleanup(dir); dir = null; });

  test('the registry declares at least one native-alias runtime and one without a tier map', () => {
    // Guards the parity rows below against passing vacuously over an empty set.
    assert.ok(NATIVE.length > 0, 'no runtime declares hostBehaviors.nativeModelAliases');
    assert.ok(NON_NATIVE_NO_MAP.length > 0, 'every non-native runtime has a tier map');
  });

  for (const profile of ['quality', 'balanced', 'budget']) {
    test(`every profiled agent gets its tier alias (profile ${profile}, claude)`, () => {
      dir = mkProject({ model_profile: profile, resolve_model_ids: 'omit' });
      for (const agent of AGENTS) {
        const tier = tierIn(dir, agent, 'claude');
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

  test('documented invariant: the resolver never reads CLAUDE_CODE_SUBAGENT_MODEL', () => {
    // Guards a future read: the env var is host-side (Claude Code), the profile alias must not depend on it.
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

  test('codex (a detected runtime with a tier map) resolves its own map literal under omit', () => {
    dir = mkProject({ model_profile: 'balanced', resolve_model_ids: 'omit' });
    assert.strictEqual(resolveIn(dir, 'gsd-planner', 'codex'), 'gpt-5.6-sol');
  });

  test('a registered runtime with its own tier map resolves that map under omit (pi)', () => {
    dir = mkProject({ model_profile: 'balanced', resolve_model_ids: 'omit' });
    assert.strictEqual(resolveIn(dir, 'gsd-planner', 'pi'), RUNTIME_PROFILE_MAP.pi.opus.model);
    assert.strictEqual(resolveIn(dir, 'gsd-planner', 'pi'), 'claude-opus-4-8');
  });

  test('GSD_RUNTIME names a registered runtime: loadConfig materializes it as config.runtime (pi, vscode, zcode)', () => {
    dir = mkProject({ model_profile: 'balanced' });
    for (const rt of ['pi', 'vscode', 'zcode']) {
      assert.strictEqual(withEnv(dir, rt, {}, () => loadConfig(dir)).runtime, rt, rt);
    }
  });

  test('vscode and zcode (no tier map) stay blank under omit', () => {
    dir = mkProject({ model_profile: 'balanced', resolve_model_ids: 'omit' });
    for (const rt of ['vscode', 'zcode']) {
      assert.strictEqual(resolveIn(dir, 'gsd-planner', rt), '', rt);
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
    assert.strictEqual(payload.executor_model, tierIn(dir, 'gsd-executor', 'claude'));
    assert.strictEqual(payload.planner_model, 'opus');
    const modelKeys = Object.keys(payload).filter((k) => k.endsWith('_model'));
    assert.ok(modelKeys.length >= 2, `expected at least 2 *_model keys, got ${modelKeys.join(',')}`);
    for (const k of modelKeys) {
      assert.ok(ALIAS_TIERS.has(payload[k]), `${k}: expected an alias tier, got ${JSON.stringify(payload[k])}`);
    }
  });

  test('a non-native runtime without a tier map still binds "" in the init payload', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit' });
    const payload = JSON.parse(cli(dir, 'init quick --raw', { GSD_RUNTIME: NON_NATIVE_NO_MAP[0] }));
    assert.strictEqual(payload.executor_model, '');
    for (const k of Object.keys(payload).filter((key) => key.endsWith('_model'))) {
      assert.strictEqual(payload[k], '', k);
    }
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
        const tier = tierIn(dir, agent, runtime);
        const model = resolveIn(dir, agent, runtime);
        assert.strictEqual(model, ALIAS_TIERS.has(tier) ? tier : '');
      },
    ));
  });
});

describe('#3703: dynamic_routing under omit escalates by tier alias', () => {
  let dir;
  afterEach(() => { if (dir) cleanup(dir); dir = null; });

  const DR = { enabled: true, tier_models: { light: 'claude-haiku-4-5', standard: 'claude-sonnet-4-5', heavy: 'claude-opus-4-8' } };
  const MAPPER = 'gsd-codebase-mapper';

  test('first spawn uses the routed tier\'s alias, not the profile tier or a tier_models id', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit', dynamic_routing: DR });
    assert.strictEqual(resolveIn(dir, MAPPER, 'claude'), 'haiku');
    // The --pick tier report is unchanged: it is the profile tier, not the routed one.
    assert.strictEqual(tierIn(dir, MAPPER, 'claude'), 'sonnet');
  });

  test('resolveModelForTier attempt 0 agrees with resolveModelInternal', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit', dynamic_routing: DR });
    // #3703: under omit on claude, routing escalates by tier alias.
    assert.strictEqual(resolveForTierIn(dir, MAPPER, 'claude', 0), 'haiku');
    for (const agent of AGENTS) {
      assert.strictEqual(resolveForTierIn(dir, agent, 'claude', 0), resolveIn(dir, agent, 'claude'), agent);
    }
  });

  test('escalation at max_escalations-1, max_escalations, max_escalations+1 (default 1)', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit', dynamic_routing: DR });
    // #3703: under omit on claude, routing escalates by tier alias.
    assert.deepStrictEqual(
      [0, 1, 2].map((a) => resolveForTierIn(dir, MAPPER, 'claude', a)),
      ['haiku', 'sonnet', 'sonnet'],
    );
  });

  test('max_escalations 2 lets the alias reach opus and caps there', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit', dynamic_routing: { ...DR, max_escalations: 2 } });
    // #3703: under omit on claude, routing escalates by tier alias.
    assert.deepStrictEqual(
      [1, 2, 3].map((a) => resolveForTierIn(dir, MAPPER, 'claude', a)),
      ['sonnet', 'opus', 'opus'],
    );
  });

  test('escalate_on_failure false pins the first routed alias', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit', dynamic_routing: { ...DR, escalate_on_failure: false } });
    // #3703: under omit on claude, routing escalates by tier alias.
    assert.strictEqual(resolveForTierIn(dir, MAPPER, 'claude', 1), 'haiku');
  });

  test('max_escalations 0 pins the first routed alias', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit', dynamic_routing: { ...DR, max_escalations: 0 } });
    assert.deepStrictEqual(
      [0, 1].map((a) => resolveForTierIn(dir, MAPPER, 'claude', a)),
      ['haiku', 'haiku'],
    );
  });

  test('an omit only in the shared defaults is ignored on claude, so routing returns tier_models ids', () => {
    // Branch D of loadConfig (src/config-loader.cts:1107-1170): with NO .planning/ directory the
    // loader reads <GSD_HOME>/.gsd/defaults.json and copies model_profile, resolve_model_ids and
    // dynamic_routing into the config. withEnv points GSD_HOME at dir.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3703-'));
    fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
    const DRd = { ...DR, provider_escalation: ['gpt-x', 'gemini-y'] };
    fs.writeFileSync(path.join(dir, '.gsd', 'defaults.json'), JSON.stringify({ model_profile: 'quality', resolve_model_ids: 'omit', dynamic_routing: DRd }));
    // claude: the defaults-level omit is not applied, so the routed tier_models id is unchanged.
    assert.strictEqual(resolveIn(dir, MAPPER, 'claude'), 'claude-haiku-4-5');
    assert.strictEqual(resolveForTierIn(dir, MAPPER, 'claude', 1), 'claude-sonnet-4-5');
    // non-native control: the same defaults DO blank the model there.
    assert.strictEqual(resolveIn(dir, MAPPER, NON_NATIVE_NO_MAP[0]), '');
    // provider ladder is live on claude because the omit was not applied.
    const r = withEnv(dir, 'claude', {}, () => resolveProviderEscalation(dir, MAPPER, 1, true));
    assert.strictEqual(r.escalated, true);
    assert.strictEqual(r.to, 'gpt-x');
  });

  test('a heavy-routed agent stays opus on escalation', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit', dynamic_routing: DR });
    // #3703: under omit on claude, routing escalates by tier alias.
    assert.strictEqual(resolveForTierIn(dir, 'gsd-planner', 'claude', 1), 'opus');
  });

  test('profile inherit stays blank on every attempt', () => {
    dir = mkProject({ model_profile: 'inherit', resolve_model_ids: 'omit', dynamic_routing: DR });
    assert.strictEqual(resolveIn(dir, MAPPER, 'claude'), '');
    assert.strictEqual(resolveForTierIn(dir, MAPPER, 'claude', 0), '');
    assert.strictEqual(resolveForTierIn(dir, MAPPER, 'claude', 1), '');
  });

  test('no tier_models entry for the routed tier falls back to the profile alias', () => {
    dir = mkProject({
      model_profile: 'quality',
      resolve_model_ids: 'omit',
      dynamic_routing: { enabled: true, tier_models: { standard: 'claude-sonnet-4-5', heavy: 'claude-opus-4-8' } },
    });
    assert.strictEqual(resolveIn(dir, MAPPER, 'claude'), 'sonnet');
    assert.strictEqual(resolveForTierIn(dir, MAPPER, 'claude', 0), 'sonnet');
  });

  test('control: without omit, escalation still returns tier_models ids', () => {
    dir = mkProject({ model_profile: 'quality', dynamic_routing: DR });
    assert.strictEqual(resolveForTierIn(dir, MAPPER, 'claude', 1), 'claude-sonnet-4-5');
  });

  test('a runtime without native aliases or a tier map stays blank on every attempt', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit', dynamic_routing: DR });
    for (const rt of NON_NATIVE_NO_MAP) {
      for (const attempt of [0, 1, 2]) {
        // #3703: the omit gate's blank holds on every attempt.
        assert.strictEqual(resolveForTierIn(dir, MAPPER, rt, attempt), '', `${rt} attempt ${attempt}`);
      }
    }
  });

  test('the resolve-execution CLI escalates by alias', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit', dynamic_routing: DR });
    const parsed = JSON.parse(cli(dir, `resolve-execution ${MAPPER} --attempt 1`));
    // #3703: under omit on claude, routing escalates by tier alias.
    assert.strictEqual(parsed.model, 'sonnet');
  });
});

describe('#3703: property — under omit on a native runtime, no attempt yields a tier_models id', () => {
  let dir;
  beforeEach(() => { dir = mkProject({}); });
  afterEach(() => { cleanup(dir); });

  const DR = { enabled: true, tier_models: { light: 'claude-haiku-4-5', standard: 'claude-sonnet-4-5', heavy: 'claude-opus-4-8' } };

  test('fc: under omit on a native runtime, the result is exactly the escalated tier alias', () => {
    fc.assert(fc.property(
      fc.constantFrom(...VALID_PROFILES),
      fc.constantFrom(...AGENTS),
      fc.integer({ min: 0, max: 3 }),
      fc.integer({ min: 0, max: 2 }),
      fc.constantFrom(...NATIVE),
      (profile, agent, attempt, maxEscalations, runtime) => {
        writeProjectConfig(dir, {
          model_profile: profile,
          resolve_model_ids: 'omit',
          dynamic_routing: { ...DR, max_escalations: maxEscalations },
        });
        const result = resolveForTierIn(dir, agent, runtime, attempt);
        // The config has no models.<phase> override, so tierIn is the profile tier.
        const profileTier = tierIn(dir, agent, runtime);
        let expected;
        if (!ALIAS_TIERS.has(profileTier)) {
          expected = '';
        } else if (AGENT_DEFAULT_TIERS[agent] === undefined) {
          expected = profileTier;
        } else {
          let walked = AGENT_DEFAULT_TIERS[agent];
          for (let i = 0; i < Math.min(attempt, maxEscalations); i += 1) {
            const next = nextTier(walked);
            if (!next || next === walked) break;
            walked = next;
          }
          expected = catalog.adaptiveTierMap[walked];
        }
        assert.strictEqual(result, expected, `${agent}/${profile}/${runtime} attempt ${attempt} max ${maxEscalations}`);
        assert.ok(!Object.values(DR.tier_models).includes(result), `${agent}: leaked a tier_models id ${result}`);
      },
    ));
  });
});

describe('#3703: provider_escalation under omit', () => {
  let dir;
  afterEach(() => { if (dir) cleanup(dir); dir = null; });

  const DR = { enabled: true, tier_models: { light: 'claude-haiku-4-5', standard: 'claude-sonnet-4-5', heavy: 'claude-opus-4-8' } };
  const PE = { ...DR, provider_escalation: ['gpt-x', 'gemini-y'] };
  const MAPPER = 'gsd-codebase-mapper';

  function ladder(cwd, runtime, attempt) {
    return withEnv(cwd, runtime, {}, () => resolveProviderEscalation(cwd, MAPPER, attempt, true));
  }

  test('claude + omit keeps the tier alias and does not swap providers', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit', dynamic_routing: PE });
    const r = ladder(dir, 'claude', 1);
    assert.strictEqual(r.to, 'haiku');
    assert.strictEqual(r.escalated, false);
    // to === from (the attempt-0 model): the ladder was not consulted.
    assert.ok(!PE.provider_escalation.includes(r.to));
  });

  test('every non-native runtime without a tier map stays blank under omit', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit', dynamic_routing: PE });
    for (const rt of NON_NATIVE_NO_MAP) {
      const r = ladder(dir, rt, 1);
      assert.strictEqual(r.to, '', rt);
      assert.strictEqual(r.escalated, false, rt);
    }
  });

  test('control: claude without omit walks the ladder (boundary at the cap)', () => {
    dir = mkProject({ model_profile: 'quality', dynamic_routing: PE });
    const first = ladder(dir, 'claude', 1);
    assert.strictEqual(first.to, 'gpt-x');
    assert.strictEqual(first.escalated, true);
    writeProjectConfig(dir, { model_profile: 'quality', dynamic_routing: { ...PE, max_escalations: 2 } });
    assert.strictEqual(ladder(dir, 'claude', 2).to, 'gemini-y');
  });

  test('an explicit non-Claude opt-in that resolved its own tier map keeps the ladder', () => {
    dir = mkProject({ model_profile: 'quality', runtime: 'codex', resolve_model_ids: 'omit', dynamic_routing: PE });
    const r = ladder(dir, 'codex', 1);
    assert.strictEqual(r.escalated, true);
    assert.strictEqual(r.to, 'gpt-x');
    assert.notStrictEqual(r.from, '');
  });

  test('resolve-execution CLI escalates by alias and skips the provider swap under omit', () => {
    dir = mkProject({ model_profile: 'quality', resolve_model_ids: 'omit', dynamic_routing: PE });
    const parsed = JSON.parse(cli(dir, `resolve-execution ${MAPPER} --attempt 1 --failure-class quota-exceeded`));
    assert.strictEqual(parsed.model, 'sonnet');
    assert.strictEqual(parsed.escalation.escalated, false);
    assert.notStrictEqual(parsed.escalation.to, 'gpt-x');
  });
});
