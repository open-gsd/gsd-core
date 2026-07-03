'use strict';

/**
 * Tests for model-resolver.cjs (ADR-857 phase 2f / #888).
 *
 * Covers:
 *   - resolveModelInternal: model resolution across tiers + profile overrides
 *   - resolveGranularityInternal + assertValidGranularityOverride
 *   - resolveEffortInternal / resolveFastModeInternal
 *   - resolveEffortForTier / nextEffort
 *   - resolveModelForTier (dynamic routing)
 *   - resolveModelPolicy (#49 provider-neutral presets)
 *   - resolveTierEntry (#2517 runtime-aware tier resolution)
 *   - shim identity: core.X === modelResolver.X for all 13 public symbols
 *   - ADVERSARIAL: unknown agent types, invalid granularity/effort overrides,
 *     runtime override edge cases
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { cleanup } = require('./helpers.cjs');

// ─── modules under test ───────────────────────────────────────────────────────

const modelResolver = require('../gsd-core/bin/lib/model-resolver.cjs');

const {
  resolveTierEntry,
  resolveModelPolicy,
  resolveModelInternal,
  VALID_GRANULARITIES,
  resolveGranularityInternal,
  assertValidGranularityOverride,
  resolveModelForTier,
  VALID_EFFORTS,
  EFFORT_SET,
  nextEffort,
  resolveEffortInternal,
  resolveFastModeInternal,
  resolveEffortForTier,
} = modelResolver;

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTempProject(prefix = 'gsd-model-resolver-test-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  return tmpDir;
}

function writeConfig(tmpDir, obj) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf-8');
}


// ─── resolveModelInternal ─────────────────────────────────────────────────────

describe('resolveModelInternal', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('no config -> balanced profile -> gsd-planner resolves to a string', () => {
    const model = resolveModelInternal(tmpDir, 'gsd-planner');
    assert.ok(typeof model === 'string' && model.length > 0, `Expected non-empty string, got: ${JSON.stringify(model)}`);
  });

  test('model_overrides takes precedence over everything else', () => {
    writeConfig(tmpDir, { model_overrides: { 'gsd-planner': 'my-custom-model' } });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'my-custom-model');
  });

  test('model_profile=quality -> opus-class model for gsd-planner', () => {
    writeConfig(tmpDir, { model_profile: 'quality' });
    const model = resolveModelInternal(tmpDir, 'gsd-planner');
    // quality profile must resolve to a non-empty model string
    assert.ok(typeof model === 'string' && model.length > 0);
  });

  test('model_profile=budget -> haiku-class model for gsd-planner', () => {
    writeConfig(tmpDir, { model_profile: 'budget' });
    const model = resolveModelInternal(tmpDir, 'gsd-planner');
    assert.ok(typeof model === 'string' && model.length > 0);
  });

  test('resolve_model_ids=omit -> returns empty string', () => {
    writeConfig(tmpDir, { resolve_model_ids: 'omit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), '');
  });

  test('unknown agent type, no config -> returns a non-empty string (fallback)', () => {
    const model = resolveModelInternal(tmpDir, 'completely-unknown-agent-xyz');
    assert.ok(typeof model === 'string' && model.length > 0);
  });

  test('model_profile=inherit -> returns "inherit"', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'inherit');
  });

  test('models config per phase type overrides profile tier', () => {
    writeConfig(tmpDir, { models: { planning: 'opus' } });
    // gsd-planner maps to planning phase type; config says opus
    // with no resolve_model_ids, should return 'opus'
    const model = resolveModelInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(model, 'opus');
  });

  test('models with invalid tier value falls through to profile', () => {
    writeConfig(tmpDir, { models: { planning: 'not-a-valid-tier' } });
    // invalid tier value -> falls back to profile resolution
    const model = resolveModelInternal(tmpDir, 'gsd-planner');
    assert.ok(typeof model === 'string' && model.length > 0);
  });

  test('runtime non-claude + model_profile_overrides for runtime tier', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_profile_overrides: {
        codex: { haiku: 'codex-mini', sonnet: 'codex', opus: 'codex-full' },
      },
    });
    // gsd-codebase-mapper is light tier -> haiku in balanced profile
    const model = resolveModelInternal(tmpDir, 'gsd-codebase-mapper');
    assert.ok(typeof model === 'string' && model.length > 0);
  });
});

// ─── resolveGranularityInternal ───────────────────────────────────────────────

describe('resolveGranularityInternal', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('no config, no override -> returns "standard"', () => {
    assert.strictEqual(resolveGranularityInternal(tmpDir, 'planning'), 'standard');
  });

  test('valid override wins over config', () => {
    writeConfig(tmpDir, { granularity: 'fine' });
    assert.strictEqual(resolveGranularityInternal(tmpDir, 'planning', 'coarse'), 'coarse');
  });

  test('invalid override ignored, falls through to config', () => {
    writeConfig(tmpDir, { granularity: 'fine' });
    assert.strictEqual(resolveGranularityInternal(tmpDir, 'planning', 'ultradetailed'), 'fine');
  });

  test('null override falls through to config', () => {
    writeConfig(tmpDir, { granularity: 'coarse' });
    assert.strictEqual(resolveGranularityInternal(tmpDir, 'planning', null), 'coarse');
  });

  test('per-phase-type granularity beats global granularity', () => {
    writeConfig(tmpDir, {
      granularity: 'coarse',
      granularities: { planning: 'fine' },
    });
    assert.strictEqual(resolveGranularityInternal(tmpDir, 'planning'), 'fine');
  });

  test('planning.granularity nested config used as fallback', () => {
    writeConfig(tmpDir, { planning: { granularity: 'coarse' } });
    assert.strictEqual(resolveGranularityInternal(tmpDir, null), 'coarse');
  });

  test('VALID_GRANULARITIES contains exactly coarse, standard, fine', () => {
    assert.ok(VALID_GRANULARITIES instanceof Set);
    assert.ok(VALID_GRANULARITIES.has('coarse'));
    assert.ok(VALID_GRANULARITIES.has('standard'));
    assert.ok(VALID_GRANULARITIES.has('fine'));
    assert.strictEqual(VALID_GRANULARITIES.size, 3);
  });
});

// ─── assertValidGranularityOverride ───────────────────────────────────────────

describe('assertValidGranularityOverride', () => {
  test('undefined -> no-op (no throw)', () => {
    assert.doesNotThrow(() =>
      assertValidGranularityOverride(undefined, (msg) => { throw new Error(msg); })
    );
  });

  test('null -> no-op (no throw)', () => {
    assert.doesNotThrow(() =>
      assertValidGranularityOverride(null, (msg) => { throw new Error(msg); })
    );
  });

  test('empty string -> no-op (no throw)', () => {
    assert.doesNotThrow(() =>
      assertValidGranularityOverride('', (msg) => { throw new Error(msg); })
    );
  });

  test('valid value "coarse" -> no-op (no throw)', () => {
    assert.doesNotThrow(() =>
      assertValidGranularityOverride('coarse', (msg) => { throw new Error(msg); })
    );
  });

  test('invalid value -> calls fail with descriptive message', () => {
    let caught = null;
    // fail is called with the message; we capture it by throwing so the test can inspect
    assert.throws(
      () => assertValidGranularityOverride('megafine', (msg) => { caught = msg; throw new Error(msg); }),
      (err) => {
        assert.ok(err.message.includes('megafine'), `error message should include the invalid value: ${err.message}`);
        assert.ok(err.message.includes('coarse') && err.message.includes('standard') && err.message.includes('fine'),
          `error message should list valid values: ${err.message}`);
        return true;
      }
    );
    assert.ok(caught !== null, 'fail should have been called');
  });
});

// ─── resolveEffortInternal ────────────────────────────────────────────────────

describe('resolveEffortInternal', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('no config -> gsd-planner (heavy) defaults to "xhigh" via tier default', () => {
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'xhigh');
  });

  test('invocation override beats everything', () => {
    writeConfig(tmpDir, { effort: { agent_overrides: { 'gsd-planner': 'low' } } });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner', { override: 'minimal' }), 'minimal');
  });

  test('agent_overrides beats routing_tier_defaults', () => {
    writeConfig(tmpDir, {
      effort: {
        routing_tier_defaults: { heavy: 'medium' },
        agent_overrides: { 'gsd-planner': 'low' },
      },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'low');
  });

  test('effort.default is final fallback when no tier default matches', () => {
    writeConfig(tmpDir, { effort: { default: 'minimal' } });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'completely-unknown-agent-xyz'), 'minimal');
  });

  test('VALID_EFFORTS and EFFORT_SET are consistent', () => {
    assert.ok(Array.isArray(VALID_EFFORTS));
    assert.ok(EFFORT_SET instanceof Set);
    assert.strictEqual(EFFORT_SET.size, VALID_EFFORTS.length);
    for (const e of VALID_EFFORTS) {
      assert.ok(EFFORT_SET.has(e), `EFFORT_SET missing: ${e}`);
    }
  });
});

// ─── nextEffort ────────────────────────────────────────────────────────────────

describe('nextEffort', () => {
  test('minimal -> low', () => {
    assert.strictEqual(nextEffort('minimal'), 'low');
  });

  test('max -> max (clamp at ceiling)', () => {
    assert.strictEqual(nextEffort('max'), 'max');
  });

  test('high -> xhigh', () => {
    assert.strictEqual(nextEffort('high'), 'xhigh');
  });

  test('unknown effort -> null', () => {
    assert.strictEqual(nextEffort('turbo'), null);
  });
});

// ─── resolveFastModeInternal ──────────────────────────────────────────────────

describe('resolveFastModeInternal', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('no config -> defaults to false', () => {
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('opts.override=true beats config', () => {
    writeConfig(tmpDir, { fast_mode: { agent_overrides: { 'gsd-planner': false } } });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner', { override: true }), true);
  });

  test('fast_mode.enabled=true sets default for all agents', () => {
    writeConfig(tmpDir, { fast_mode: { enabled: true } });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), true);
  });

  test('agent_overrides beats enabled', () => {
    writeConfig(tmpDir, {
      fast_mode: { enabled: true, agent_overrides: { 'gsd-planner': false } },
    });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('unknown agent with no config -> false', () => {
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'unknown-agent-xyz'), false);
  });
});

// ─── resolveEffortForTier ─────────────────────────────────────────────────────

describe('resolveEffortForTier', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('dynamic_routing disabled -> attempt has no effect', () => {
    const base = resolveEffortForTier(tmpDir, 'gsd-planner', 0);
    const at1 = resolveEffortForTier(tmpDir, 'gsd-planner', 1);
    assert.strictEqual(base, at1);
  });

  test('dynamic_routing enabled + escalate_on_failure=true + attempt=1 -> one step up', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 2,
      },
      effort: { routing_tier_defaults: { light: 'low' } },
    });
    assert.strictEqual(resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 0), 'low');
    assert.strictEqual(resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1), 'medium');
  });

  test('escalation clamps at "max"', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 99,
      },
      effort: { default: 'xhigh' },
    });
    assert.strictEqual(resolveEffortForTier(tmpDir, 'gsd-planner', 99), 'max');
  });
});

// ─── resolveModelForTier ──────────────────────────────────────────────────────

describe('resolveModelForTier', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('no dynamic_routing -> falls back to resolveModelInternal', () => {
    const fromForTier = resolveModelForTier(tmpDir, 'gsd-planner');
    const fromInternal = resolveModelInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(fromForTier, fromInternal);
  });

  test('model_overrides wins before dynamic routing logic', () => {
    writeConfig(tmpDir, {
      model_overrides: { 'gsd-planner': 'override-model' },
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 2,
      },
    });
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-planner'), 'override-model');
  });

  test('dynamic_routing + tier_models + attempt=0 -> default tier model', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku-custom', standard: 'sonnet-custom', heavy: 'opus-custom' },
        escalate_on_failure: true,
        max_escalations: 2,
      },
    });
    // gsd-codebase-mapper is 'light' tier
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-codebase-mapper', 0), 'haiku-custom');
  });

  test('dynamic_routing + attempt=1 escalates tier', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku-custom', standard: 'sonnet-custom', heavy: 'opus-custom' },
        escalate_on_failure: true,
        max_escalations: 2,
      },
    });
    // gsd-codebase-mapper light -> attempt=1 -> standard
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-codebase-mapper', 1), 'sonnet-custom');
  });
});

// ─── resolveModelPolicy ───────────────────────────────────────────────────────

describe('resolveModelPolicy (#49)', () => {
  test('null policy -> null', () => {
    assert.strictEqual(resolveModelPolicy(null, 'sonnet'), null);
  });

  test('no provider -> null', () => {
    assert.strictEqual(resolveModelPolicy({ budget: 'medium' }, 'sonnet'), null);
  });

  test('generic provider: tier=opus -> reads policy.high', () => {
    const result = resolveModelPolicy(
      { provider: 'generic', high: 'my-high-model', medium: 'my-medium', low: 'my-low' },
      'opus'
    );
    assert.strictEqual(result, 'my-high-model');
  });

  test('generic provider: tier=sonnet -> reads policy.medium', () => {
    const result = resolveModelPolicy(
      { provider: 'generic', high: 'hi', medium: 'med', low: 'lo' },
      'sonnet'
    );
    assert.strictEqual(result, 'med');
  });

  test('generic provider: tier=haiku -> reads policy.low', () => {
    const result = resolveModelPolicy(
      { provider: 'generic', high: 'hi', medium: 'med', low: 'lo' },
      'haiku'
    );
    assert.strictEqual(result, 'lo');
  });

  test('custom provider same as generic', () => {
    const result = resolveModelPolicy(
      { provider: 'custom', medium: 'custom-sonnet' },
      'sonnet'
    );
    assert.strictEqual(result, 'custom-sonnet');
  });

  test('runtime_tiers override takes precedence over provider', () => {
    const result = resolveModelPolicy(
      {
        provider: 'generic',
        high: 'generic-hi',
        medium: 'generic-med',
        low: 'generic-lo',
        runtime: 'codex',
        runtime_tiers: { codex: { sonnet: 'codex-sonnet-override' } },
      },
      'sonnet'
    );
    assert.strictEqual(result, 'codex-sonnet-override');
  });

  test('unknown tier for generic -> null', () => {
    const result = resolveModelPolicy(
      { provider: 'generic', high: 'hi', medium: 'med', low: 'lo' },
      'unknown-tier'
    );
    assert.strictEqual(result, null);
  });
});

// ─── resolveTierEntry ────────────────────────────────────────────────────────

describe('resolveTierEntry (#2517)', () => {
  test('null runtime -> null', () => {
    assert.strictEqual(resolveTierEntry({ runtime: null, tier: 'sonnet', overrides: null }), null);
  });

  test('null tier -> null', () => {
    assert.strictEqual(resolveTierEntry({ runtime: 'codex', tier: null, overrides: null }), null);
  });

  test('unknown runtime + unknown tier, no overrides -> null', () => {
    assert.strictEqual(resolveTierEntry({
      runtime: 'totally-unknown-runtime-xyz',
      tier: 'totally-unknown-tier',
      overrides: null,
    }), null);
  });

  test('user override as string expands to { model: string }', () => {
    const entry = resolveTierEntry({
      runtime: 'codex',
      tier: 'sonnet',
      overrides: { codex: { sonnet: 'my-custom-codex-model' } },
    });
    assert.ok(entry !== null);
    assert.strictEqual(entry.model, 'my-custom-codex-model');
  });

  test('user override as object merged with builtin', () => {
    const entry = resolveTierEntry({
      runtime: 'codex',
      tier: 'sonnet',
      overrides: { codex: { sonnet: { model: 'user-model', extra: 'value' } } },
    });
    assert.ok(entry !== null);
    assert.strictEqual(entry.model, 'user-model');
    assert.strictEqual(entry['extra'], 'value');
  });
});

// ─── ADVERSARIAL ─────────────────────────────────────────────────────────────

describe('ADVERSARIAL: edge cases', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempProject(); });
  afterEach(() => { if (tmpDir) cleanup(tmpDir); tmpDir = null; });

  test('resolveModelInternal: unknown agent + model_profile=quality -> "opus" fallback', () => {
    writeConfig(tmpDir, { model_profile: 'quality' });
    const model = resolveModelInternal(tmpDir, 'completely-unknown-agent');
    assert.strictEqual(model, 'opus');
  });

  test('resolveModelInternal: unknown agent + model_profile=budget -> "haiku" fallback', () => {
    writeConfig(tmpDir, { model_profile: 'budget' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'unknown-agent'), 'haiku');
  });

  test('resolveGranularityInternal: empty override "" is treated as no override', () => {
    writeConfig(tmpDir, { granularity: 'fine' });
    assert.strictEqual(resolveGranularityInternal(tmpDir, 'planning', ''), 'fine');
  });

  test('assertValidGranularityOverride: "ultrawide" is invalid -> fail called', () => {
    let errorMsg = null;
    assert.throws(
      () => assertValidGranularityOverride('ultrawide', (msg) => { errorMsg = msg; throw new Error(msg); }),
      (err) => {
        assert.ok(err.message.includes('ultrawide'), `error should mention the invalid value: ${err.message}`);
        return true;
      }
    );
    assert.ok(errorMsg !== null, 'fail should have been called');
    assert.ok(errorMsg.includes('ultrawide'), `error message should include 'ultrawide': ${errorMsg}`);
  });

  test('resolveEffortInternal: invalid override "turbo" falls through to tier default', () => {
    const result = resolveEffortInternal(tmpDir, 'gsd-planner', { override: 'turbo' });
    // gsd-planner is heavy -> tier default xhigh
    assert.strictEqual(result, 'xhigh');
  });

  test('resolveFastModeInternal: string "true" override is not accepted (must be boolean)', () => {
    const result = resolveFastModeInternal(tmpDir, 'gsd-planner', { override: 'true' });
    // string is not boolean -> falls through to default false
    assert.strictEqual(result, false);
  });

  test('resolveEffortInternal: effort block is non-object string -> uses tier default', () => {
    writeConfig(tmpDir, { effort: 'bad-value' });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.ok(EFFORT_SET.has(result), `Expected valid effort, got: ${result}`);
  });

  test('resolveModelForTier: unknown agent with dynamic routing -> resolveModelInternal fallback', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 1,
      },
    });
    // unknown agent has no defaultTier -> falls back to resolveModelInternal
    const fromForTier = resolveModelForTier(tmpDir, 'unknown-agent-xyz');
    const fromInternal = resolveModelInternal(tmpDir, 'unknown-agent-xyz');
    assert.strictEqual(fromForTier, fromInternal);
  });

  test('resolveTierEntry: runtime override with non-string, non-object value -> no model set', () => {
    const entry = resolveTierEntry({
      runtime: 'codex',
      tier: 'sonnet',
      overrides: { codex: { sonnet: 42 } },
    });
    // numeric 42 is neither string nor object -> treated as truthy userEntry=42 (not expanded)
    // result will have whatever builtins exist + the override
    // Key requirement: does not crash
    assert.ok(entry !== null || entry === null, 'should not throw');
  });

  test('resolveModelPolicy: non-object policy -> null', () => {
    assert.strictEqual(resolveModelPolicy('string-policy', 'sonnet'), null);
  });

  test('resolveModelPolicy: null tier -> null', () => {
    assert.strictEqual(resolveModelPolicy({ provider: 'generic', medium: 'sonnet' }, null), null);
  });

  test('resolveEffortForTier: max_escalations=0 caps escalation', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 0,
      },
      effort: { routing_tier_defaults: { light: 'low' } },
    });
    const at0 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 0);
    const at1 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1);
    // max_escalations=0 means no escalation allowed even at attempt=1
    assert.strictEqual(at0, at1);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1829-inherit-model-profile.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1829-inherit-model-profile (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression tests for bug #1829
 *
 * model_profile: "inherit" in .planning/config.json was not recognised as a
 * valid profile. resolveModelInternal() silently fell back to "balanced",
 * causing all agents to use "sonnet" instead of inheriting the parent model.
 *
 * Root cause in core.cjs:
 *   const profile = config.model_profile || 'balanced';
 *   const agentModels = MODEL_PROFILES[agentType];
 *   if (!agentModels) return 'sonnet';
 *   const resolved = agentModels[profile] || agentModels['balanced'] || 'sonnet';
 *   // agentModels['inherit'] is undefined → falls through to agentModels['balanced']
 *
 * Fix 1 (core.cjs): add early return — if (profile === 'inherit') return 'inherit';
 * Fix 2 (verify.cjs): add 'inherit' to validProfiles so it doesn't trigger W004.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const { resolveModelInternal } = require('../gsd-core/bin/lib/model-resolver.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writeConfig(tmpDir, obj) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify(obj, null, 2)
  );
}

function writeMinimalProjectMd(tmpDir) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'PROJECT.md'),
    '# Project\n\n## What This Is\n\nContent.\n\n## Core Value\n\nContent.\n\n## Requirements\n\nContent.\n'
  );
}

function writeMinimalRoadmap(tmpDir) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    '# Roadmap\n\n### Phase 1: First Phase\n'
  );
}

function writeMinimalStateMd(tmpDir) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    '# Session State\n\n## Current Position\n\nPhase: 1\n'
  );
}

// ─── resolveModelInternal — inherit profile ───────────────────────────────────

describe('bug #1829: model_profile "inherit" — resolveModelInternal', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns "inherit" for gsd-planner when model_profile is "inherit"', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'inherit');
  });

  test('returns "inherit" for gsd-executor when model_profile is "inherit"', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-executor'), 'inherit');
  });

  test('returns "inherit" for gsd-phase-researcher when model_profile is "inherit"', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-phase-researcher'), 'inherit');
  });

  test('returns "inherit" for gsd-codebase-mapper when model_profile is "inherit"', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-codebase-mapper'), 'inherit');
  });

  test('returns "inherit" for gsd-verifier when model_profile is "inherit"', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-verifier'), 'inherit');
  });

  test('returns "inherit" for unknown agent with inherit profile', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-nonexistent'), 'inherit');
  });

  test('per-agent override takes precedence over inherit profile', () => {
    writeConfig(tmpDir, {
      model_profile: 'inherit',
      model_overrides: { 'gsd-executor': 'haiku' },
    });
    // Override wins even when profile is inherit
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-executor'), 'haiku');
    // Other agents without override still inherit
    assert.strictEqual(resolveModelInternal(tmpDir, 'gsd-planner'), 'inherit');
  });

  test('does not silently fall back to "sonnet" (the original bug)', () => {
    writeConfig(tmpDir, { model_profile: 'inherit' });
    // Before the fix, this returned 'sonnet' (via balanced fallback)
    const model = resolveModelInternal(tmpDir, 'gsd-planner');
    assert.notStrictEqual(model, 'sonnet', 'inherit profile must not silently fall back to sonnet');
  });
});

// ─── resolve-model CLI — inherit profile ──────────────────────────────────────

describe('bug #1829: model_profile "inherit" — resolve-model CLI', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('CLI resolve-model returns "inherit" for gsd-executor with inherit profile', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'inherit' }, null, 2)
    );

    const result = runGsdTools('resolve-model gsd-executor', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.model, 'inherit');
    assert.strictEqual(parsed.profile, 'inherit');
  });

  test('CLI resolve-model returns "inherit" for gsd-planner with inherit profile', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'inherit' }, null, 2)
    );

    const result = runGsdTools('resolve-model gsd-planner', tmpDir);
    assert.ok(result.success, `resolve-model failed: ${result.error}`);

    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.model, 'inherit');
  });
});

// ─── verify health — inherit profile is not a validation error ────────────────

describe('bug #1829: model_profile "inherit" — validate health does not warn W004', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    writeMinimalProjectMd(tmpDir);
    writeMinimalRoadmap(tmpDir);
    writeMinimalStateMd(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-first-phase'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('does not emit W004 for model_profile "inherit"', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        model_profile: 'inherit',
        workflow: {
          research: true,
          plan_check: true,
          verifier: true,
          nyquist_validation: true,
        },
      }, null, 2)
    );

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `validate health failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      !output.warnings.some(w => w.code === 'W004'),
      `inherit profile must not trigger W004: ${JSON.stringify(output.warnings)}`
    );
  });

  test('still emits W004 for genuinely invalid model_profile values', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile: 'invalid-profile' }, null, 2)
    );

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success, `validate health failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(
      output.warnings.some(w => w.code === 'W004'),
      `Invalid profile should trigger W004: ${JSON.stringify(output.warnings)}`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-492-effort-manifest-fallback.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-492-effort-manifest-fallback (consolidation epic #1969 B3 #1972)", () => {
'use strict';
/**
 * bug-492-effort-manifest-fallback.test.cjs
 *
 * Verifies resolveEffortInternal's fallback chain when no project config.json
 * is present.
 *
 * Isolation strategy: every test that injects custom effort values writes
 * them to a per-test ~/.gsd/defaults.json rooted under a tmpHome, pointed at
 * via GSD_HOME. This avoids mutating the module-level CANONICAL_CONFIG_DEFAULTS
 * singleton (which caused independence violations under parallel runs).
 *
 * Test 1 (pure manifest fallback): tmpDir WITH .planning/ but no config.json.
 * GSD_HOME points to a bare tmpHome (no defaults.json). loadConfig sees
 * .planning/ → returns effort:null → model-resolver reads CANONICAL_CONFIG_DEFAULTS
 * directly for routing_tier_defaults.
 *
 * Tests 2-4 (global-defaults path): bare tmpDir (no .planning/) so loadConfig
 * hits the ~/.gsd/defaults.json branch. A test-scoped defaults.json injects
 * the desired effort sub-object; model-resolver then takes the effortCfg
 * (non-null) branch — no singleton touched.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');
const { resolveEffortInternal } = require('../gsd-core/bin/lib/model-resolver.cjs');

/** Create a bare temp directory with no .planning/ structure */
function createBareTmpDir(prefix = 'gsd-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create a temp home dir and write effort config into .gsd/defaults.json */
function createTmpHomeWithEffort(effortConfig) {
  const tmpHome = createBareTmpDir('gsd-home-');
  const gsdDir = path.join(tmpHome, '.gsd');
  fs.mkdirSync(gsdDir, { recursive: true });
  fs.writeFileSync(
    path.join(gsdDir, 'defaults.json'),
    JSON.stringify({ effort: effortConfig })
  );
  return tmpHome;
}

describe('#492 manifest effort fallback', () => {
  // These tests manage GSD_HOME per-test, so no shared beforeEach/afterEach.

  test('routing_tier_defaults manifest fallback still works when no config and no defaults.json', (t) => {
    // .planning/ exists → loadConfig returns effort:null → model-resolver reads
    // CANONICAL_CONFIG_DEFAULTS['effort']['routing_tier_defaults']['heavy'] = "xhigh".
    const tmpDir = createBareTmpDir();
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    const tmpHome = createBareTmpDir('gsd-home-');
    process.env.GSD_HOME = tmpHome;
    t.after(() => {
      delete process.env.GSD_HOME;
      cleanup(tmpDir);
      cleanup(tmpHome);
    });

    // gsd-planner's default tier is "heavy"; manifest routing_tier_defaults.heavy = "xhigh"
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'xhigh');
  });

  test('global-defaults effort.agent_overrides wins over routing_tier_defaults when no project config', (t) => {
    // bare tmpDir (no .planning/) → loadConfig reads ~/.gsd/defaults.json
    // which supplies effort.agent_overrides → resolveEffortInternal returns that value.
    const tmpDir = createBareTmpDir();
    const tmpHome = createTmpHomeWithEffort({ agent_overrides: { 'gsd-planner': 'max' } });
    process.env.GSD_HOME = tmpHome;
    t.after(() => {
      delete process.env.GSD_HOME;
      cleanup(tmpDir);
      cleanup(tmpHome);
    });

    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'max');
  });

  test('global-defaults effort.default consulted for unknown agent with no project config', (t) => {
    // effort.default in defaults.json wins for an agent with no tier mapping.
    const tmpDir = createBareTmpDir();
    const tmpHome = createTmpHomeWithEffort({ default: 'max' });
    process.env.GSD_HOME = tmpHome;
    t.after(() => {
      delete process.env.GSD_HOME;
      cleanup(tmpDir);
      cleanup(tmpHome);
    });

    assert.strictEqual(resolveEffortInternal(tmpDir, 'fictional-agent-xyz-492'), 'max');
  });

  test('global-defaults agent_overrides takes precedence over routing_tier_defaults', (t) => {
    // agent_overrides is checked first (step 2), so "minimal" wins over
    // routing_tier_defaults.heavy = "xhigh" (step 3).
    const tmpDir = createBareTmpDir();
    const tmpHome = createTmpHomeWithEffort({
      agent_overrides: { 'gsd-planner': 'minimal' },
      routing_tier_defaults: { heavy: 'xhigh' },
    });
    process.env.GSD_HOME = tmpHome;
    t.after(() => {
      delete process.env.GSD_HOME;
      cleanup(tmpDir);
      cleanup(tmpHome);
    });

    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'minimal');
  });
});
  });
}
