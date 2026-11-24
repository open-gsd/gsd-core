'use strict';

/**
 * #6214 — resolveModelForTier (resolve-execution --attempt N, the provider
 * ladder's `from`, the passive model adapter) and resolveModelInternal
 * (resolve-model, init payloads) must agree on every attempt that does not
 * move the dynamic_routing tier off the first spawn's tier.
 *
 * Owner decision (2026-11-14): resolveModelInternal's precedence is the single
 * truth for those attempts. model_overrides, model_policy, the runtime tier
 * map and a model_profile_overrides.claude pin all outrank
 * dynamic_routing.tier_models. A genuine escalation still returns
 * tier_models[next tier].
 *
 * Acceptance (#6214): "Both entry points agree on attempt 0. A first spawn
 * resolved through `resolve-execution --attempt 0` should get the same model as
 * the one `resolve-model` / `init` report for that agent."
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fc = require('./helpers/fast-check-setup.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { isolatedEnv } = require('./helpers/isolated-env.cjs');

const {
  resolveModelInternal,
  resolveModelForTier,
  resolveProviderEscalation,
  _resetInstallRuntimeMarkerCacheForTests,
} = require('../gsd-core/bin/lib/model-resolver.cjs');
const { MODEL_PROFILES, RUNTIME_PROFILE_MAP } = require('../gsd-core/bin/lib/model-catalog.cjs');
const { AGENT_DEFAULT_TIERS } = require('../gsd-core/bin/lib/model-profiles.cjs');

const ENV_KEYS = ['GSD_RUNTIME', 'GSD_HOME', 'HOME', 'USERPROFILE', 'GSD_WORKSTREAM', 'GSD_PROJECT', 'CLAUDE_CODE_SUBAGENT_MODEL'];

const DR = { enabled: true, tier_models: { light: 'claude-haiku-4-5', standard: 'claude-sonnet-4-5', heavy: 'claude-opus-4-8' } };
const MAPPER = 'gsd-codebase-mapper'; // default tier: light
const PLANNER = 'gsd-planner'; // default tier: heavy
const ISSUE_CONFIG = { model_profile: 'balanced', runtime: 'codex', dynamic_routing: DR };
// The codex light-tier model the issue reports from resolve-model.
const LUNA = 'gpt-5.6-luna';

function mkProject(config) {
  const dir = createTempProject('gsd-6214-');
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(config));
  return dir;
}

// The runtime is declared explicitly and HOME/GSD_HOME point into the project,
// so neither the shell that runs the suite nor ~/.gsd/defaults.json can change
// an expected value.
function withEnv(dir, runtime, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.GSD_HOME = dir;
    process.env.GSD_RUNTIME = runtime;
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

const internalIn = (dir, agent, rt) => withEnv(dir, rt, () => resolveModelInternal(dir, agent));
const forTierIn = (dir, agent, rt, attempt) => withEnv(dir, rt, () => resolveModelForTier(dir, agent, attempt));

describe('#6214: attempt 0 agrees with resolve-model', () => {
  let dir;
  afterEach(() => { if (dir) cleanup(dir); dir = null; });

  test('issue repro: attempt 0 agrees with resolve-model on codex', () => {
    dir = mkProject(ISSUE_CONFIG);
    assert.strictEqual(internalIn(dir, MAPPER, 'codex'), RUNTIME_PROFILE_MAP.codex.haiku.model);
    assert.strictEqual(internalIn(dir, MAPPER, 'codex'), LUNA);
    assert.strictEqual(forTierIn(dir, MAPPER, 'codex', 0), LUNA);
  });

  test('a runtime declared only by GSD_RUNTIME (no config key) agrees at attempt 0', () => {
    dir = mkProject({ model_profile: 'balanced', dynamic_routing: DR });
    assert.strictEqual(forTierIn(dir, MAPPER, 'codex', 0), internalIn(dir, MAPPER, 'codex'));
    assert.strictEqual(forTierIn(dir, MAPPER, 'codex', 0), LUNA);
  });

  test('model_policy on claude outranks tier_models at attempt 0', () => {
    dir = mkProject({ model_profile: 'balanced', model_policy: { provider: 'anthropic' }, dynamic_routing: DR });
    assert.strictEqual(internalIn(dir, MAPPER, 'claude'), 'haiku');
    assert.strictEqual(forTierIn(dir, MAPPER, 'claude', 0), 'haiku');
  });

  test('claude tier override outranks tier_models at attempt 0', () => {
    dir = mkProject({
      model_profile: 'balanced',
      model_profile_overrides: { claude: { haiku: 'claude-haiku-4-5-20251001' } },
      dynamic_routing: DR,
    });
    assert.strictEqual(internalIn(dir, MAPPER, 'claude'), 'claude-haiku-4-5-20251001');
    assert.strictEqual(forTierIn(dir, MAPPER, 'claude', 0), 'claude-haiku-4-5-20251001');
  });

  test('explicit non-Claude opt-in under project omit agrees at attempt 0', () => {
    dir = mkProject({ ...ISSUE_CONFIG, resolve_model_ids: 'omit' });
    assert.strictEqual(internalIn(dir, MAPPER, 'codex'), LUNA);
    assert.strictEqual(forTierIn(dir, MAPPER, 'codex', 0), LUNA);
  });

  test('provider escalation `from` is the resolve-model model', () => {
    dir = mkProject({ ...ISSUE_CONFIG, dynamic_routing: { ...DR, provider_escalation: ['gpt-x'] } });
    const r = withEnv(dir, 'codex', () => resolveProviderEscalation(dir, MAPPER, 0, false));
    assert.strictEqual(r.from, LUNA);
    assert.deepStrictEqual(r.attempted, [LUNA]);
  });

  test('CLI: resolve-execution --attempt 0 model equals resolve-model', () => {
    dir = mkProject(ISSUE_CONFIG);
    const env = isolatedEnv({ home: dir, override: { GSD_HOME: dir, GSD_RUNTIME: 'codex', CLAUDE_CODE_SUBAGENT_MODEL: '' } });
    const picked = runGsdTools(['query', 'resolve-model', MAPPER, '--pick', 'model'], dir, env);
    assert.ok(picked.success, picked.error);
    const exec = runGsdTools(['resolve-execution', MAPPER, '--attempt', '0'], dir, env);
    assert.ok(exec.success, exec.error);
    assert.strictEqual(picked.output.trim(), LUNA);
    assert.strictEqual(JSON.parse(exec.output).model, LUNA);
  });
});

describe('#6214: an attempt that does not move the tier is the first spawn', () => {
  let dir;
  afterEach(() => { if (dir) cleanup(dir); dir = null; });

  test('max_escalations 0: attempt 1 equals attempt 0', () => {
    dir = mkProject({ ...ISSUE_CONFIG, dynamic_routing: { ...DR, max_escalations: 0 } });
    assert.strictEqual(forTierIn(dir, MAPPER, 'codex', 1), LUNA);
  });

  test('max_escalations 1: attempt 1 escalates to tier_models', () => {
    dir = mkProject({ ...ISSUE_CONFIG, dynamic_routing: { ...DR, max_escalations: 1 } });
    assert.strictEqual(forTierIn(dir, MAPPER, 'codex', 1), 'claude-sonnet-4-5');
  });

  test('attempt past the cap stays at the cap tier model', () => {
    dir = mkProject({ ...ISSUE_CONFIG, dynamic_routing: { ...DR, max_escalations: 1 } });
    assert.strictEqual(forTierIn(dir, MAPPER, 'codex', 2), 'claude-sonnet-4-5');
  });

  test('escalate_on_failure false: every attempt equals attempt 0', () => {
    dir = mkProject({ ...ISSUE_CONFIG, dynamic_routing: { ...DR, escalate_on_failure: false } });
    for (const attempt of [0, 1, 3]) {
      assert.strictEqual(forTierIn(dir, MAPPER, 'codex', attempt), LUNA, `attempt ${attempt}`);
    }
  });

  test('saturated heavy tier equals attempt 0', () => {
    dir = mkProject(ISSUE_CONFIG);
    assert.strictEqual(AGENT_DEFAULT_TIERS[PLANNER], 'heavy');
    const first = internalIn(dir, PLANNER, 'codex');
    assert.strictEqual(first, RUNTIME_PROFILE_MAP.codex.opus.model);
    assert.strictEqual(forTierIn(dir, PLANNER, 'codex', 1), first);
  });
});

describe('#6214: behavior that must not change', () => {
  let dir;
  afterEach(() => { if (dir) cleanup(dir); dir = null; });

  test('plain claude attempt 0 still returns tier_models[default]', () => {
    dir = mkProject({ model_profile: 'balanced', dynamic_routing: DR });
    assert.strictEqual(forTierIn(dir, MAPPER, 'claude', 0), 'claude-haiku-4-5');
    assert.strictEqual(forTierIn(dir, MAPPER, 'claude', 1), 'claude-sonnet-4-5');
  });

  test('routing disabled: every attempt equals resolve-model', () => {
    dir = mkProject({ model_profile: 'balanced', runtime: 'codex', dynamic_routing: { ...DR, enabled: false } });
    for (const attempt of [0, 1, 2]) {
      assert.strictEqual(forTierIn(dir, MAPPER, 'codex', attempt), internalIn(dir, MAPPER, 'codex'));
    }
  });

  test('model_overrides wins at escalated attempts', () => {
    dir = mkProject({ ...ISSUE_CONFIG, model_overrides: { [MAPPER]: 'gpt-x' } });
    assert.strictEqual(forTierIn(dir, MAPPER, 'codex', 0), 'gpt-x');
    assert.strictEqual(forTierIn(dir, MAPPER, 'codex', 1), 'gpt-x');
  });

  test('an inherit project stays on the session model until a real escalation', () => {
    dir = mkProject({ model_profile: 'inherit', dynamic_routing: DR });
    assert.strictEqual(forTierIn(dir, MAPPER, 'claude', 0), 'inherit');
    assert.strictEqual(forTierIn(dir, MAPPER, 'claude', 1), 'claude-sonnet-4-5');
  });
});

describe('#6214: property', () => {
  test('property: an attempt that does not move the tier resolves the first spawn\'s model', (t) => {
    const dirs = [];
    t.after(() => { for (const d of dirs) cleanup(d); });
    // Independent oracle: the documented ladder light -> standard -> heavy -> heavy.
    const TIER_ORDER = ['light', 'standard', 'heavy'];
    const agents = Object.keys(MODEL_PROFILES).filter((a) => TIER_ORDER.includes(AGENT_DEFAULT_TIERS[a]));
    assert.ok(agents.length > 0, 'no agent declares a routing tier');
    fc.assert(fc.property(
      fc.record({
        runtime: fc.constantFrom('claude', 'codex', 'opencode'),
        profile: fc.constantFrom('quality', 'balanced', 'budget'),
        agent: fc.constantFrom(...agents),
        attempt: fc.integer({ min: 0, max: 3 }),
        maxEsc: fc.integer({ min: 0, max: 3 }),
        escalate: fc.boolean(),
        explicitRuntime: fc.boolean(),
        policy: fc.boolean(),
        claudePin: fc.boolean(),
      }),
      (s) => {
        const config = {
          model_profile: s.profile,
          dynamic_routing: { ...DR, max_escalations: s.maxEsc, escalate_on_failure: s.escalate },
        };
        if (s.explicitRuntime) config.runtime = s.runtime;
        if (s.policy) config.model_policy = { provider: 'anthropic' };
        if (s.claudePin) config.model_profile_overrides = { claude: { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-4-5-20250929' } };
        const dir = mkProject(config);
        dirs.push(dir);
        const effective = s.escalate ? Math.min(s.attempt, s.maxEsc) : 0;
        const startIdx = TIER_ORDER.indexOf(AGENT_DEFAULT_TIERS[s.agent]);
        const endIdx = Math.min(startIdx + effective, TIER_ORDER.length - 1);
        const first = internalIn(dir, s.agent, s.runtime);
        const got = forTierIn(dir, s.agent, s.runtime, s.attempt);
        assert.strictEqual(forTierIn(dir, s.agent, s.runtime, 0), first);
        if (endIdx === startIdx) {
          assert.strictEqual(got, first);
        } else if (s.policy && s.runtime !== 'claude') {
          // A non-Claude model_policy pins every attempt.
          assert.strictEqual(got, first);
        } else {
          assert.strictEqual(got, DR.tier_models[TIER_ORDER[endIdx]]);
        }
      },
    ), { numRuns: 60 });
  });
});
