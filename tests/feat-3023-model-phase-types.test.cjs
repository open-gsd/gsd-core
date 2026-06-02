/**
 * Feature test for issue #3023 — per-phase-type model map.
 *
 * Adds a `models` block to .planning/config.json that accepts phase-type
 * keys (planning / discuss / research / execution / verification /
 * completion). Resolution precedence:
 *
 *   1. Per-agent `model_overrides[agent]`         (highest)
 *   2. Phase-type `models[phase_type]`            (NEW)
 *   3. Profile table (`model_profile`)
 *   4. Runtime default
 *
 * Tests are typed-IR / structural — assert on the value returned by
 * resolveModelInternal, not stdout/grep. Each test seeds a temp project
 * with a fixture .planning/config.json and asserts the resolver picks
 * the right tier for each agent.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveModelInternal,
} = require('../get-shit-done/bin/lib/core.cjs');
const {
  AGENT_TO_PHASE_TYPE,
  VALID_PHASE_TYPES,
  MODEL_PROFILES,
} = require('../get-shit-done/bin/lib/model-profiles.cjs');
const { isValidConfigKey } = require('../get-shit-done/bin/lib/config-schema.cjs');

const { createTempDir, cleanup } = require('./helpers.cjs');
const makeTmp = (prefix) => createTempDir(`gsd-3023-${prefix}-`);

function writeConfig(projectDir, config) {
  const planningDir = path.join(projectDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(config, null, 2));
}

function rmr(p) {
  cleanup(p);
}

// ─── Schema: AGENT_TO_PHASE_TYPE table + VALID_PHASE_TYPES ──────────────────

describe('#3023 phase-type schema: every agent has a phase-type assignment', () => {
  test('AGENT_TO_PHASE_TYPE is exported as a non-empty object', () => {
    assert.equal(typeof AGENT_TO_PHASE_TYPE, 'object');
    assert.ok(AGENT_TO_PHASE_TYPE !== null);
    assert.ok(Object.keys(AGENT_TO_PHASE_TYPE).length > 0);
  });

  test('VALID_PHASE_TYPES exposes the six named slots from the issue', () => {
    // The issue specified exactly these slots. Adding new slots here is a
    // schema change that must coordinate with config-schema's dynamic
    // pattern and the docs.
    assert.deepStrictEqual(
      [...VALID_PHASE_TYPES].sort(),
      ['completion', 'discuss', 'execution', 'planning', 'research', 'verification'].sort()
    );
  });

  test('every agent in MODEL_PROFILES has a phase-type assignment', () => {
    const missing = Object.keys(MODEL_PROFILES).filter(
      (agent) => !AGENT_TO_PHASE_TYPE[agent]
    );
    assert.deepStrictEqual(missing, [],
      `every agent in MODEL_PROFILES must have a phase-type — missing: ${JSON.stringify(missing)}`);
  });

  test('every assigned phase-type is one of the six valid slots', () => {
    const invalid = Object.entries(AGENT_TO_PHASE_TYPE).filter(
      ([, phaseType]) => !VALID_PHASE_TYPES.has(phaseType)
    );
    assert.deepStrictEqual(invalid, [],
      `phase-type assignments must use VALID_PHASE_TYPES — invalid: ${JSON.stringify(invalid)}`);
  });
});

// ─── Resolver behavior: phase-type drives tier ──────────────────────────────

describe('#3023 resolver: models.<phase_type> overrides profile-based tier', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('resolver'); });
  afterEach(() => { rmr(projectDir); });

  test('phase-type alone — research agents get the phase-type tier, planner gets profile default', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: { research: 'haiku' },
    });
    // gsd-phase-researcher is a research agent — should pick up 'haiku'
    // from the phase-type slot, not 'sonnet' from the balanced profile.
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'haiku');
    // gsd-codebase-mapper is also research → haiku
    assert.equal(resolveModelInternal(projectDir, 'gsd-codebase-mapper'), 'haiku');
    // gsd-planner is planning, no models.planning set → falls through to
    // profile (balanced → opus per MODEL_PROFILES).
    assert.equal(resolveModelInternal(projectDir, 'gsd-planner'), 'opus');
  });

  test('per-agent override beats phase-type (acceptance criterion b)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: { research: 'haiku' },
      model_overrides: { 'gsd-phase-researcher': 'opus' },
    });
    // The targeted per-agent override wins for that one agent.
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'opus');
    // Other research agents still pick up the phase-type tier.
    assert.equal(resolveModelInternal(projectDir, 'gsd-codebase-mapper'), 'haiku');
    assert.equal(resolveModelInternal(projectDir, 'gsd-research-synthesizer'), 'haiku');
  });

  test('phase-type beats profile (acceptance criterion c)', () => {
    // model_profile=quality would normally make research agents 'opus'.
    // models.research='haiku' must win.
    writeConfig(projectDir, {
      model_profile: 'quality',
      models: { research: 'haiku' },
    });
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'haiku');
    assert.equal(resolveModelInternal(projectDir, 'gsd-codebase-mapper'), 'haiku');
    // gsd-planner is planning, no slot set, profile=quality → opus.
    assert.equal(resolveModelInternal(projectDir, 'gsd-planner'), 'opus');
  });

  test('issue example: opus for planning/discuss/execution, sonnet for research/verification/completion', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: {
        planning: 'opus',
        discuss: 'opus',
        execution: 'opus',
        research: 'sonnet',
        verification: 'sonnet',
        completion: 'sonnet',
      },
    });
    // Planning agents → opus
    assert.equal(resolveModelInternal(projectDir, 'gsd-planner'), 'opus');
    // Execution agents → opus
    assert.equal(resolveModelInternal(projectDir, 'gsd-executor'), 'opus');
    // Research agents → sonnet
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'sonnet');
    // Verification agents → sonnet
    assert.equal(resolveModelInternal(projectDir, 'gsd-verifier'), 'sonnet');
  });

  test('phase-type "inherit" is honored (preserves existing inherit semantics)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: { research: 'inherit' },
    });
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'inherit');
  });

  test('empty models block is a no-op (acceptance criterion: backward compat)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: {},
    });
    // Behavior must match no-models config (balanced profile).
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'sonnet');
    assert.equal(resolveModelInternal(projectDir, 'gsd-planner'), 'opus');
  });

  test('no models block at all is a no-op (acceptance criterion: backward compat)', () => {
    writeConfig(projectDir, {
      model_profile: 'balanced',
    });
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'sonnet');
    assert.equal(resolveModelInternal(projectDir, 'gsd-planner'), 'opus');
  });

  test('unrecognized tier value falls through to profile (typo safety) — CR follow-up', () => {
    // The VALID_TIERS guard in resolveModelInternal must reject any value
    // that isn't a known tier alias and fall back to the profile tier.
    // Without this guard a typo like "haiku3" would pollute the runtime
    // resolution chain. Locks the guard in so a future regression that
    // removes it is caught.
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: { research: 'haiku3' }, // typo; not a valid tier alias
    });
    // Falls back to balanced → sonnet for research agents.
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'sonnet');
    assert.equal(resolveModelInternal(projectDir, 'gsd-codebase-mapper'), 'haiku',
      'gsd-codebase-mapper at balanced is haiku per profile, unaffected by typo');
  });

  test('full model ID in models.<phase_type> is rejected; falls through to profile — CR follow-up', () => {
    // Full IDs are not valid in models.<phase_type>; they belong in
    // model_overrides per agent. The guard ensures we don't accidentally
    // hand a full ID into the runtime-tier resolution chain.
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: { research: 'openai/gpt-5' },
    });
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'sonnet');
  });

  // ─── CR Major: phase-type beats inherit profile ─────────────────────────
  // Pre-fix bug: model_profile='inherit' + models.execution='opus' returned
  // 'inherit' because the profile short-circuit fired BEFORE the phase-type
  // override could win, violating the documented precedence where
  // models[phase_type] beats model_profile.

  test('phase-type override wins over profile=inherit (CR Major) — model resolver', () => {
    writeConfig(projectDir, {
      model_profile: 'inherit',
      models: { execution: 'opus' },
    });
    // gsd-executor (execution) must get the phase-type opus, not inherit.
    assert.equal(resolveModelInternal(projectDir, 'gsd-executor'), 'opus');
  });

  test('phase-type "haiku" wins over profile=inherit; agents without a slot still inherit', () => {
    writeConfig(projectDir, {
      model_profile: 'inherit',
      models: { research: 'haiku' },
    });
    // research agents → haiku (phase-type wins)
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'haiku');
    assert.equal(resolveModelInternal(projectDir, 'gsd-codebase-mapper'), 'haiku');
    // planning agent has no slot set → falls through to profile=inherit.
    assert.equal(resolveModelInternal(projectDir, 'gsd-planner'), 'inherit');
  });

  test('profile=inherit with no models block still returns inherit (no regression)', () => {
    writeConfig(projectDir, {
      model_profile: 'inherit',
    });
    assert.equal(resolveModelInternal(projectDir, 'gsd-executor'), 'inherit');
    assert.equal(resolveModelInternal(projectDir, 'gsd-phase-researcher'), 'inherit');
  });

  test('profile=inherit with models block but agent has no slot → inherit', () => {
    writeConfig(projectDir, {
      model_profile: 'inherit',
      models: { research: 'haiku' },
    });
    // gsd-executor (execution slot) is not set → falls through to inherit.
    assert.equal(resolveModelInternal(projectDir, 'gsd-executor'), 'inherit');
  });
});

// ─── #443 Unified effort: resolveEffortInternal + renderEffortForRuntime ────

const { resolveEffortInternal } = require('../get-shit-done/bin/lib/core.cjs');
const { renderEffortForRuntime } = require('../get-shit-done/bin/lib/model-catalog.cjs');

describe('#3023 + #443: unified effort resolver (resolveEffortInternal) for Codex', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('effort'); });
  afterEach(() => { rmr(projectDir); });

  test('resolveEffortInternal exported from core.cjs', () => {
    assert.equal(typeof resolveEffortInternal, 'function');
  });

  test('effort derives from AGENT_DEFAULT_TIERS (routing), not phase-type; gsd-executor is standard → high', () => {
    // Under unification, effort is config-driven via routing_tier_defaults.
    // gsd-executor has routing tier 'standard' → default effort 'high', regardless
    // of models.execution phase-type or model_profile setting.
    writeConfig(projectDir, {
      runtime: 'codex',
      model_profile: 'balanced',
      models: { execution: 'opus' },
    });
    const eff = resolveEffortInternal(projectDir, 'gsd-executor');
    // standard tier → 'high' (not 'xhigh' from opus, not 'medium' from old catalog)
    assert.equal(eff, 'high');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.equal(rendered.param, 'model_reasoning_effort');
    assert.equal(rendered.value, 'high');
  });

  test('effort resolves universally even when models.execution=inherit', () => {
    // Under unification, models.execution='inherit' does not affect effort resolution.
    // Effort always resolves from routing_tier_defaults: gsd-executor (standard) → 'high'.
    writeConfig(projectDir, {
      runtime: 'codex',
      model_profile: 'balanced',
      models: { execution: 'inherit' },
    });
    const eff = resolveEffortInternal(projectDir, 'gsd-executor');
    assert.equal(eff, 'high');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.equal(rendered.param, 'model_reasoning_effort');
    assert.equal(rendered.value, 'high');
  });

  test('per-agent model_overrides does not affect effort (effort is routing-tier-based)', () => {
    // Under unification, effort does not check model_overrides.
    // gsd-executor (standard tier) → 'high' regardless.
    writeConfig(projectDir, {
      runtime: 'codex',
      model_profile: 'balanced',
      models: { execution: 'opus' },
      model_overrides: { 'gsd-executor': 'openai/gpt-5' },
    });
    const eff = resolveEffortInternal(projectDir, 'gsd-executor');
    assert.equal(eff, 'high');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.equal(rendered.param, 'model_reasoning_effort');
    assert.equal(rendered.value, 'high');
  });

  test('Claude runtime: effort is first-class (emits output_config.effort, not null)', () => {
    // Under unification, Claude effort is first-class via output_config.effort.
    // No `runtime` set → defaults to claude (no runtime key → undefined runtime).
    writeConfig(projectDir, {
      model_profile: 'balanced',
      models: { execution: 'opus' },
    });
    const eff = resolveEffortInternal(projectDir, 'gsd-executor');
    // effort resolves universally; claude render gives output_config.effort
    const rendered = renderEffortForRuntime(undefined, eff);
    // undefined runtime yields param=null (no runtime key set)
    assert.equal(rendered.param, null);
    // But if explicitly set to 'claude':
    const renderedClaude = renderEffortForRuntime('claude', eff);
    assert.equal(renderedClaude.param, 'output_config.effort');
    assert.equal(renderedClaude.value, 'high');
  });

  test('profile=inherit does not affect effort; effort resolves from routing tier', () => {
    // Under unification, effort is completely independent of model_profile.
    // gsd-executor (standard routing tier) → 'high' even with model_profile='inherit'.
    writeConfig(projectDir, {
      runtime: 'codex',
      model_profile: 'inherit',
      models: { execution: 'opus' },
    });
    const eff = resolveEffortInternal(projectDir, 'gsd-executor');
    assert.equal(eff, 'high',
      'profile=inherit must not affect effort; standard routing tier → high');
    const rendered = renderEffortForRuntime('codex', eff);
    assert.equal(rendered.param, 'model_reasoning_effort');
    assert.equal(rendered.value, 'high');
  });
});

// ─── Schema validation ──────────────────────────────────────────────────────

describe('#3023 config-schema: models.<phase_type> validation', () => {
  test('models.planning is a valid config key', () => {
    assert.equal(isValidConfigKey('models.planning'), true);
  });

  test('all six phase-type slots are valid config keys', () => {
    for (const slot of ['planning', 'discuss', 'research', 'execution', 'verification', 'completion']) {
      assert.equal(isValidConfigKey(`models.${slot}`), true,
        `models.${slot} must be a valid config key`);
    }
  });

  test('unknown phase-type is rejected (acceptance criterion d)', () => {
    assert.equal(isValidConfigKey('models.deployment'), false,
      'unknown phase-type must NOT be accepted');
    assert.equal(isValidConfigKey('models.gsd-planner'), false,
      'agent name in models.* must NOT be accepted (use model_overrides for agents)');
  });

  test('models alone (without a slot) is not a valid config-set key', () => {
    // Setting the whole block isn't a granular set; users edit JSON directly.
    assert.equal(isValidConfigKey('models'), false);
  });
});
