/**
 * Feature test for issue #49 — model_policy presets.
 *
 * Adds a `model_policy` block to .planning/config.json:
 *
 *   {
 *     "model_policy": {
 *       "provider": "anthropic-fable",
 *       "budget": "high",
 *       "runtime_tiers": {
 *         "opencode": {
 *           "opus": { "model": "anthropic/claude-opus-4-8" }
 *         }
 *       }
 *     }
 *   }
 *
 * Resolution precedence in resolveModelInternal (highest → lowest):
 *   1. model_overrides[agent]                 (per-agent full IDs; existing)
 *   2. model_policy.runtime_tiers[runtime][tier]  (Sub-path A: explicit runtime+tier entry)
 *   3. model_policy provider preset + budget  (Sub-path B: known-provider catalog lookup)
 *   4. model_profile_overrides                (legacy runtime-aware overrides)
 *   5. resolve_model_ids / profile fallback
 *
 * Sub-path A (runtime_tiers) fires when config.runtime matches a key inside
 * model_policy.runtime_tiers AND that key contains an entry for the resolved tier.
 *
 * Sub-path B (provider preset) fires when model_policy.provider is a known
 * provider AND the catalog contains an entry for (tier, budget) pair.
 *
 * Both sub-paths return a string model ID. Failures in either sub-path fall
 * through cleanly to the next step in the chain.
 *
 * New config keys accepted by isValidConfigKey:
 *   - model_policy.provider
 *   - model_policy.budget
 *   - model_policy.runtime_tiers.<runtime>.<tier>
 *
 * Backwards compatibility:
 *   - model_profile_overrides continues to work when model_policy is absent.
 *   - When both are set, model_policy wins (fires first).
 *
 * KNOWN_PROVIDERS is exported from both model-catalog.cjs and core.cjs (re-export).
 *
 * These tests are written to FAIL before implementation. They use typed-IR /
 * structural assertions on resolveModelInternal / resolveModelPolicy / isValidConfigKey
 * return values — not stdout / grep.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ─── Imports (will fail until implementation exists) ────────────────────────
// resolveModelPolicy is a new internal function that must be exported from core.cjs.
// KNOWN_PROVIDERS must be exported from model-catalog.cjs and re-exported by core.cjs.
const {
  resolveModelInternal,
  resolveModelPolicy,
  resolveModelForTier,
  KNOWN_PROVIDERS,
  _resetRuntimeWarningCacheForTests,
} = require('../gsd-core/bin/lib/core.cjs');

// KNOWN_PROVIDERS must also be exported directly from model-catalog.cjs
const modelCatalog = require('../gsd-core/bin/lib/model-catalog.cjs');

const { isValidConfigKey } = require('../gsd-core/bin/lib/config-schema.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const makeTmp = (prefix) => createTempDir(`gsd-49-${prefix}-`);

function writeConfig(dir, config) {
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(config, null, 2));
}

function rmr(p) {
  cleanup(p);
}

// ─── resolveModelPolicy unit tests ──────────────────────────────────────────
//
// resolveModelPolicy(config, tier) is the pure resolver that takes a loaded
// config object and a resolved tier string. It returns a string model ID when
// model_policy produces a hit, or null when it falls through.

describe('#49 resolveModelPolicy: null/absent policy returns null', () => {
  test('resolveModelPolicy returns null when policy is null or absent', () => {
    // policy is null
    assert.strictEqual(resolveModelPolicy(null, 'opus'), null);
    // policy is undefined
    assert.strictEqual(resolveModelPolicy(undefined, 'opus'), null);
    // policy is absent (empty object treated as absent)
    assert.strictEqual(resolveModelPolicy({}, 'opus'), null);
  });

  test('resolveModelPolicy returns null when runtime or tier is missing', () => {
    const policy = { provider: 'anthropic', budget: 'high' };
    // tier is null
    assert.strictEqual(resolveModelPolicy(policy, null), null);
    // tier is empty string
    assert.strictEqual(resolveModelPolicy(policy, ''), null);
    // tier is undefined
    assert.strictEqual(resolveModelPolicy(policy, undefined), null);
  });
});

describe('#49 resolveModelPolicy Sub-path B: provider presets', () => {
  test('known provider "anthropic" + tier "opus" + budget "high" returns correct model ID', () => {
    // The anthropic preset catalog must contain an entry for opus+high.
    // The returned model ID is the high-budget anthropic opus model.
    const policy = { provider: 'anthropic', budget: 'high' };
    const result = resolveModelPolicy(policy, 'opus');
    assert.ok(typeof result === 'string' && result.length > 0,
      `expected a non-empty model ID string, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result, 'claude-opus-4-8',
      `expected anthropic opus/high to resolve to claude-opus-4-8, got: ${result}`);
  });

  test('known provider "anthropic" + tier "sonnet" + budget "high" preserves Opus 4.8 routing', () => {
    const policy = { provider: 'anthropic', budget: 'high' };
    const result = resolveModelPolicy(policy, 'sonnet');
    assert.strictEqual(result, 'claude-opus-4-8',
      `expected anthropic sonnet/high to resolve to claude-opus-4-8, got: ${result}`);
  });

  test('known provider "anthropic-fable" + tier "opus" + budget "high" resolves to Claude Fable 5', () => {
    const policy = { provider: 'anthropic-fable', budget: 'high' };
    const result = resolveModelPolicy(policy, 'opus');
    assert.strictEqual(result, 'claude-fable-5',
      `expected anthropic-fable opus/high to resolve to claude-fable-5, got: ${result}`);
  });

  test('known provider "anthropic-fable" + tier "haiku" + budget "high" keeps low tier on Sonnet', () => {
    const policy = { provider: 'anthropic-fable', budget: 'high' };
    const result = resolveModelPolicy(policy, 'haiku');
    assert.strictEqual(result, 'claude-sonnet-4-6',
      `expected anthropic-fable haiku/high to resolve to claude-sonnet-4-6, got: ${result}`);
  });

  test('known provider "openai" + tier "sonnet" + budget "low" returns model with reasoning_effort from preset', () => {
    // The openai preset catalog must contain a sonnet+low entry.
    // "openai" maps to a different model family; the entry may include reasoning_effort.
    const policy = { provider: 'openai', budget: 'low' };
    const result = resolveModelPolicy(policy, 'sonnet');
    assert.ok(typeof result === 'string' && result.length > 0,
      `expected a non-empty model ID string for openai/sonnet/low, got: ${JSON.stringify(result)}`);
  });

  test('budget absent defaults to "medium"', () => {
    // No "budget" key — defaults to "medium". The anthropic/opus/medium entry must exist.
    const policyWithBudget = { provider: 'anthropic', budget: 'medium' };
    const policyNoBudget = { provider: 'anthropic' };
    const withBudget = resolveModelPolicy(policyWithBudget, 'opus');
    const withoutBudget = resolveModelPolicy(policyNoBudget, 'opus');
    // Both must return a string (not null)
    assert.ok(typeof withBudget === 'string' && withBudget.length > 0,
      `expected model from explicit budget:'medium'`);
    assert.ok(typeof withoutBudget === 'string' && withoutBudget.length > 0,
      `expected model when budget absent (should default to medium)`);
    // They must resolve to the same value
    assert.strictEqual(withBudget, withoutBudget,
      'absent budget must behave identically to explicit "medium"');
  });

  test('provider "generic" (all null entries) returns null (falls through)', () => {
    // provider:'generic' means opaque model IDs — there's no preset catalog for
    // generic. Without a runtime_tiers hit, resolveModelPolicy returns null.
    const policy = { provider: 'generic', budget: 'high' };
    const result = resolveModelPolicy(policy, 'opus');
    assert.strictEqual(result, null,
      'provider:"generic" with no runtime_tiers must return null (no preset catalog)');
  });

  test('unknown provider string returns null without throwing', () => {
    // A typo like provider:'mistral' must not crash; it degrades gracefully.
    const policy = { provider: 'mistral', budget: 'high' };
    let result;
    assert.doesNotThrow(() => {
      result = resolveModelPolicy(policy, 'opus');
    }, 'resolveModelPolicy must not throw on unknown provider');
    assert.strictEqual(result, null,
      'unknown provider with no runtime_tiers must return null');
  });

  test('known provider + unknown tier returns null', () => {
    const policy = { provider: 'anthropic', budget: 'high' };
    const result = resolveModelPolicy(policy, 'jumbo');
    assert.strictEqual(result, null,
      'unknown tier "jumbo" must return null for anthropic provider');
  });

  test('known provider + known tier + missing budget level returns null', () => {
    // The anthropic preset for opus only defines 'high' and 'medium' but NOT 'critical'.
    // A missing budget level must fall through (return null) — not crash.
    const policy = { provider: 'anthropic', budget: 'critical' };
    const result = resolveModelPolicy(policy, 'opus');
    assert.strictEqual(result, null,
      'missing budget level "critical" must return null without throwing');
  });
});

describe('#49 resolveModelPolicy Sub-path A: runtime_tiers', () => {
  test('runtime_tiers entry wins over provider preset for same runtime+tier', () => {
    // Sub-path A fires first: explicit runtime_tiers entry overrides the
    // provider preset catalog. The returned model is the one in runtime_tiers,
    // not what the provider preset would have returned.
    const policy = {
      provider: 'anthropic',
      budget: 'high',
      runtime: 'opencode',
      runtime_tiers: {
        opencode: {
          opus: { model: 'anthropic/custom-opus-override' },
        },
      },
    };
    const result = resolveModelPolicy(policy, 'opus');
    assert.strictEqual(result, 'anthropic/custom-opus-override',
      'Sub-path A runtime_tiers must win over Sub-path B provider preset');
  });

  test('runtime_tiers string shorthand normalized to { model } object', () => {
    // String shorthand: `{ opencode: { opus: "some-model-id" } }`
    // must be normalized to `{ model: "some-model-id" }` so the resolver
    // returns the string as-is.
    const policy = {
      provider: 'anthropic',
      budget: 'high',
      runtime: 'opencode',
      runtime_tiers: {
        opencode: {
          opus: 'anthropic/string-shorthand-model',
        },
      },
    };
    const result = resolveModelPolicy(policy, 'opus');
    assert.strictEqual(result, 'anthropic/string-shorthand-model',
      'string shorthand in runtime_tiers must be normalized and returned as model ID');
  });

  test('runtime_tiers partial entry (no matching runtime) falls through to provider preset', () => {
    // runtime_tiers has entries for 'copilot' but the active runtime is 'opencode'.
    // The miss on runtime_tiers falls through to Sub-path B (provider preset).
    const policy = {
      provider: 'anthropic',
      budget: 'high',
      runtime: 'opencode',
      runtime_tiers: {
        copilot: {
          opus: { model: 'some-copilot-model' },
        },
      },
    };
    const result = resolveModelPolicy(policy, 'opus');
    // Falls through to Sub-path B (anthropic/opus/high) — must not be null.
    assert.ok(typeof result === 'string' && result.length > 0,
      'runtime_tiers miss must fall through to provider preset, got: ' + JSON.stringify(result));
    // And it must NOT be the copilot model
    assert.notStrictEqual(result, 'some-copilot-model');
  });
});

// ─── resolveModelInternal integration tests ──────────────────────────────────
//
// These tests call resolveModelInternal through a temp project's config.json.
// They verify the full resolution chain including model_policy placement.

describe('#49 resolveModelInternal: model_policy in the resolution chain', () => {
  let projectDir;
  beforeEach(() => {
    projectDir = makeTmp('internal');
    _resetRuntimeWarningCacheForTests();
  });
  afterEach(() => {
    rmr(projectDir);
    _resetRuntimeWarningCacheForTests();
  });

  test('model_policy fires before model_profile_overrides when both are set (model_policy wins)', () => {
    // model_policy (Sub-path B: anthropic/opus/high) must win over
    // model_profile_overrides when both are present.
    // We use a model_profile_overrides entry that would give a DIFFERENT result.
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
      },
      model_profile_overrides: {
        opencode: {
          // This legacy override would have returned this model — but model_policy must win.
          opus: 'legacy-override-model-should-not-appear',
        },
      },
    });
    const result = resolveModelInternal(projectDir, 'gsd-planner');
    assert.notStrictEqual(result, 'legacy-override-model-should-not-appear',
      'model_policy must fire before model_profile_overrides and win');
    assert.ok(typeof result === 'string' && result.length > 0,
      'must return a non-empty model ID');
    assert.strictEqual(result, 'claude-opus-4-8',
      'expected anthropic preset opus/high to resolve to claude-opus-4-8');
  });

  test('model_policy with provider:"anthropic" + budget:"high" + runtime:"opencode" resolves to preset model', () => {
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',  // gsd-planner quality = opus tier
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
      },
    });
    const result = resolveModelInternal(projectDir, 'gsd-planner');
    assert.ok(typeof result === 'string' && result.length > 0,
      'expected a non-empty model ID');
    assert.strictEqual(result, 'claude-opus-4-8',
      'anthropic/opus/high must resolve to claude-opus-4-8');
  });

  test('model_policy with provider:"anthropic-fable" + budget:"high" resolves to Fable preset model', () => {
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_policy: {
        provider: 'anthropic-fable',
        budget: 'high',
      },
    });
    const result = resolveModelInternal(projectDir, 'gsd-planner');
    assert.strictEqual(result, 'claude-fable-5',
      'anthropic-fable/opus/high must resolve to claude-fable-5');
  });

  test('model_policy is skipped when runtime is absent', () => {
    // No `runtime` in config — model_policy fires on any non-null policy
    // only when a runtime context is available. Without runtime, the policy
    // falls through entirely.
    // NOTE: Sub-path B (provider preset) can fire without runtime — it only
    // needs tier+budget+provider. Sub-path A requires runtime. This test
    // verifies the gating behavior described in the issue: if model_policy
    // is present but runtime is absent, provider preset Sub-path B still
    // fires (it doesn't need runtime). So "skipped" means the runtime_tiers
    // sub-path is skipped but provider preset may still fire.
    // The test asserts that resolveModelInternal does not crash and returns
    // a string regardless.
    writeConfig(projectDir, {
      model_profile: 'quality',
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
        runtime_tiers: {
          opencode: {
            opus: { model: 'should-not-appear-no-runtime' },
          },
        },
      },
    });
    let result;
    assert.doesNotThrow(() => {
      result = resolveModelInternal(projectDir, 'gsd-planner');
    });
    assert.ok(typeof result === 'string',
      'resolveModelInternal must return a string even when runtime is absent');
    // The runtime_tiers entry for opencode must not appear since runtime is absent
    assert.notStrictEqual(result, 'should-not-appear-no-runtime',
      'runtime_tiers must not fire when config.runtime is absent');
  });

  test('model_policy is skipped when runtime:"claude" (no-op gate)', () => {
    // runtime:"claude" is the implicit default and is treated as a no-op
    // for model_policy resolution (same as the no-op gate in the existing
    // runtime-aware resolution step). model_policy provider preset
    // for anthropic may still fire — but runtime_tiers for claude is a no-op
    // because claude-native resolution already handles that path.
    writeConfig(projectDir, {
      runtime: 'claude',
      model_profile: 'quality',
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
        runtime_tiers: {
          claude: {
            opus: { model: 'claude-runtime-tiers-should-not-appear' },
          },
        },
      },
    });
    let result;
    assert.doesNotThrow(() => {
      result = resolveModelInternal(projectDir, 'gsd-planner');
    });
    assert.ok(typeof result === 'string', 'must return a string');
    // The claude runtime_tiers entry must not appear — model_policy runtime_tiers
    // is a no-op for runtime:"claude"
    assert.notStrictEqual(result, 'claude-runtime-tiers-should-not-appear',
      'model_policy.runtime_tiers must be a no-op when runtime is "claude"');
  });

  test('model_policy is skipped when tier:"inherit"', () => {
    // When the resolved tier is 'inherit', model_policy must not fire.
    // This mirrors the existing behavior for runtime-aware resolution.
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'inherit',
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
      },
    });
    const result = resolveModelInternal(projectDir, 'gsd-planner');
    // With profile:'inherit', the result must be 'inherit'
    assert.strictEqual(result, 'inherit',
      'model_policy must not fire when tier is "inherit"; resolveModelInternal must return "inherit"');
  });

  test('model_profile_overrides still resolves when model_policy is absent (legacy fallback intact)', () => {
    // No model_policy — model_profile_overrides must still work exactly as before.
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_profile_overrides: {
        opencode: {
          opus: 'legacy-overridden-model',
        },
      },
    });
    const result = resolveModelInternal(projectDir, 'gsd-planner');
    assert.strictEqual(result, 'legacy-overridden-model',
      'model_profile_overrides must still win when model_policy is absent');
  });

  test('model_policy absent + model_profile_overrides set → model_profile_overrides wins (back-compat)', () => {
    // Explicit: no model_policy key at all. model_profile_overrides is the only
    // custom config. The legacy chain must apply exactly as before this feature.
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'balanced',
      model_profile_overrides: {
        opencode: {
          sonnet: 'back-compat-sonnet-model',
        },
      },
    });
    // gsd-executor has balanced/opencode -> sonnet tier
    const result = resolveModelInternal(projectDir, 'gsd-executor');
    assert.strictEqual(result, 'back-compat-sonnet-model',
      'legacy model_profile_overrides must be unaffected when model_policy is absent');
  });

  test('model_policy present but runtime_tiers empty + provider:"generic" → falls through to model_profile_overrides', () => {
    // model_policy is a stub: runtime_tiers is empty ({}), provider is "generic".
    // The resolver must fall through all model_policy paths and land on model_profile_overrides.
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_policy: {
        provider: 'generic',
        budget: 'high',
        runtime_tiers: {},
      },
      model_profile_overrides: {
        opencode: {
          opus: 'fallthrough-to-legacy',
        },
      },
    });
    const result = resolveModelInternal(projectDir, 'gsd-planner');
    assert.strictEqual(result, 'fallthrough-to-legacy',
      'empty runtime_tiers + generic provider must fall through to model_profile_overrides');
  });
});

// ─── Warning emission tests ───────────────────────────────────────────────────

describe('#49 resolveModelInternal: unknown provider warning behavior', () => {
  let projectDir;
  let origWrite;
  let captured;

  beforeEach(() => {
    projectDir = makeTmp('warnings');
    _resetRuntimeWarningCacheForTests();
    captured = [];
    origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  });

  afterEach(() => {
    process.stderr.write = origWrite;
    rmr(projectDir);
    _resetRuntimeWarningCacheForTests();
  });

  test('unknown provider in model_policy → falls through to model_profile_overrides, emits stderr warning once', () => {
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_policy: {
        provider: 'mistral',
        budget: 'high',
      },
      model_profile_overrides: {
        opencode: {
          opus: 'fallback-from-unknown-provider',
        },
      },
    });
    const result = resolveModelInternal(projectDir, 'gsd-planner');
    // Must fall through to model_profile_overrides
    assert.strictEqual(result, 'fallback-from-unknown-provider',
      'unknown provider must fall through to model_profile_overrides');
    // Must emit at least one stderr warning about the unknown provider
    const joined = captured.join('');
    assert.match(joined, /model_policy.*provider.*mistral|unknown.*provider.*mistral|mistral.*unknown/i,
      'must emit a stderr warning about the unknown provider "mistral"');
  });

  test('unknown provider warning is deduplicated (emitted only once per config label)', () => {
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_policy: {
        provider: 'mistral',
        budget: 'high',
      },
    });
    // Call resolveModelInternal multiple times for different agents — the
    // warning about the unknown provider must be emitted only once.
    resolveModelInternal(projectDir, 'gsd-planner');
    resolveModelInternal(projectDir, 'gsd-executor');
    resolveModelInternal(projectDir, 'gsd-verifier');
    const joined = captured.join('');
    // Count occurrences of "mistral" in the warning output
    const matches = (joined.match(/mistral/gi) || []).length;
    assert.ok(matches >= 1, 'expected at least one warning about "mistral"');
    assert.ok(matches <= 2, `warning for unknown provider must be deduplicated — saw ${matches} occurrences`);
  });

  test('model_policy.runtime_tiers with unknown runtime emits one-shot stderr warning', () => {
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
        runtime_tiers: {
          unknownrt: {
            opus: { model: 'some-model' },
          },
        },
      },
    });
    resolveModelInternal(projectDir, 'gsd-planner');
    const joined = captured.join('');
    // Must emit a warning about the unknown runtime key in runtime_tiers
    assert.match(joined, /unknownrt|unknown.*runtime|runtime_tiers.*unknown/i,
      'must emit a stderr warning about unknown runtime "unknownrt" in model_policy.runtime_tiers');
  });

  test('model_policy.runtime_tiers with invalid tier name emits one-shot stderr warning', () => {
    writeConfig(projectDir, {
      runtime: 'opencode',
      model_profile: 'quality',
      model_policy: {
        provider: 'anthropic',
        budget: 'high',
        runtime_tiers: {
          opencode: {
            jumbo: { model: 'invalid-tier-model' },
          },
        },
      },
    });
    resolveModelInternal(projectDir, 'gsd-planner');
    const joined = captured.join('');
    // Must emit a warning about the invalid tier name "jumbo"
    assert.match(joined, /jumbo|invalid.*tier|tier.*invalid|unknown.*tier/i,
      'must emit a stderr warning about invalid tier "jumbo" in model_policy.runtime_tiers.opencode');
  });
});

// ─── reasoning_effort passthrough tests ──────────────────────────────────────

describe('#49 reasoning_effort in model_policy entries', () => {
  let projectDir;
  beforeEach(() => { projectDir = makeTmp('effort'); });
  afterEach(() => { rmr(projectDir); });

  test('reasoning_effort in preset entry is returned as part of the entry object (caller decides whether to emit)', () => {
    // When a provider preset includes reasoning_effort (e.g. openai opus/high),
    // resolveModelPolicy must return the full entry object (or at minimum the model
    // string) without stripping reasoning_effort internally.
    // This is checked via the internal resolveModelPolicy function directly.
    // The policy object includes a runtime_tiers entry that has reasoning_effort.
    const policy = {
      provider: 'anthropic',
      budget: 'high',
      runtime: 'opencode',
      runtime_tiers: {
        opencode: {
          opus: { model: 'anthropic/claude-opus-4-8', reasoning_effort: 'high' },
        },
      },
    };
    // resolveModelPolicy must return the model string (at minimum).
    // The caller (resolveModelInternal) is responsible for deciding what to
    // emit — the resolver just returns the model ID string.
    const result = resolveModelPolicy(policy, 'opus');
    assert.strictEqual(result, 'anthropic/claude-opus-4-8',
      'resolveModelPolicy must return the model string from the runtime_tiers entry');
  });

  test('reasoning_effort in model_policy.runtime_tiers entry is returned verbatim; renderEffortForRuntime strips it when runtime not in RUNTIMES_WITH_REASONING_EFFORT', () => {
    // The renderEffortForRuntime function (already existing) handles the stripping.
    // This test verifies the contract: resolveModelPolicy returns the model string,
    // and for runtimes not in RUNTIMES_WITH_REASONING_EFFORT, the caller must not
    // emit reasoning_effort.
    const { renderEffortForRuntime, RUNTIMES_WITH_REASONING_EFFORT } = require('../gsd-core/bin/lib/model-catalog.cjs');

    // 'opencode' is NOT in RUNTIMES_WITH_REASONING_EFFORT (only codex has reasoning_effort in catalog)
    assert.ok(!RUNTIMES_WITH_REASONING_EFFORT.has('opencode'),
      'opencode must not be in RUNTIMES_WITH_REASONING_EFFORT for this test to be meaningful');

    // renderEffortForRuntime for a non-effort runtime returns channel:null
    const rendered = renderEffortForRuntime('opencode', 'high');
    assert.strictEqual(rendered.channel, null,
      'renderEffortForRuntime must return channel:null for runtimes not supporting reasoning_effort');

    // The resolveModelPolicy function returns just the model string — reasoning_effort
    // is stripped at the emit layer, not inside resolveModelPolicy.
    const policy = {
      runtime: 'opencode',
      provider: 'anthropic',
      budget: 'high',
      runtime_tiers: {
        opencode: {
          opus: { model: 'anthropic/claude-opus-4-8', reasoning_effort: 'high' },
        },
      },
    };
    const result = resolveModelPolicy(policy, 'opus');
    assert.strictEqual(result, 'anthropic/claude-opus-4-8',
      'resolveModelPolicy must return model string; reasoning_effort is stripped downstream');
  });
});

// ─── isValidConfigKey: model_policy.* schema validation ──────────────────────

describe('#49 isValidConfigKey: model_policy.* keys accepted/rejected', () => {
  test('isValidConfigKey accepts "model_policy.provider"', () => {
    assert.strictEqual(isValidConfigKey('model_policy.provider'), true,
      '"model_policy.provider" must be a valid config key');
  });

  test('isValidConfigKey accepts "model_policy.budget"', () => {
    assert.strictEqual(isValidConfigKey('model_policy.budget'), true,
      '"model_policy.budget" must be a valid config key');
  });

  test('isValidConfigKey accepts "model_policy.runtime_tiers.opencode.opus"', () => {
    assert.strictEqual(isValidConfigKey('model_policy.runtime_tiers.opencode.opus'), true,
      '"model_policy.runtime_tiers.opencode.opus" must be a valid config key');
  });

  test('isValidConfigKey rejects "model_policy.runtime_tiers.opencode.banana" (invalid tier)', () => {
    assert.strictEqual(isValidConfigKey('model_policy.runtime_tiers.opencode.banana'), false,
      '"model_policy.runtime_tiers.opencode.banana" must be rejected (banana is not a valid tier)');
  });
});

// ─── KNOWN_PROVIDERS export tests ─────────────────────────────────────────────

describe('#49 KNOWN_PROVIDERS exports from model-catalog.cjs and core.cjs', () => {
  test('KNOWN_PROVIDERS exported from core.cjs includes all keys from providerPresets in catalog', () => {
    // KNOWN_PROVIDERS must be a Set (or array) exported from core.cjs.
    assert.ok(KNOWN_PROVIDERS != null,
      'KNOWN_PROVIDERS must be exported from core.cjs');
    const isIterable = typeof KNOWN_PROVIDERS[Symbol.iterator] === 'function';
    assert.ok(isIterable,
      'KNOWN_PROVIDERS must be iterable (Set or array)');
    const providers = [...KNOWN_PROVIDERS];
    assert.ok(providers.length > 0,
      'KNOWN_PROVIDERS must not be empty');
    // 'anthropic' must be in the set since it is a required provider preset
    assert.ok(providers.includes('anthropic'),
      'KNOWN_PROVIDERS must include "anthropic"');
    assert.ok(providers.includes('anthropic-fable'),
      'KNOWN_PROVIDERS must include "anthropic-fable"');
    // 'generic' is a special fallback, not a real provider — it must NOT be in KNOWN_PROVIDERS
    // (KNOWN_PROVIDERS lists only providers with catalog entries)
    assert.ok(!providers.includes('generic'),
      'KNOWN_PROVIDERS must not include "generic" (it is not a catalog-backed provider)');
  });

  test('KNOWN_PROVIDERS exported from model-catalog.cjs matches core.cjs re-export', () => {
    // model-catalog.cjs must also export KNOWN_PROVIDERS (the canonical source).
    // core.cjs re-exports it. Both must be identical.
    assert.ok(modelCatalog.KNOWN_PROVIDERS != null,
      'KNOWN_PROVIDERS must be exported from model-catalog.cjs');
    const fromCatalog = [...modelCatalog.KNOWN_PROVIDERS].sort();
    const fromCore = [...KNOWN_PROVIDERS].sort();
    assert.deepStrictEqual(fromCore, fromCatalog,
      'KNOWN_PROVIDERS from core.cjs (re-export) must match model-catalog.cjs canonical export');
  });
});

// ─── resolveModelPolicy: Object.hasOwn prototype-pollution guards ────────────

describe('#49 resolveModelPolicy: prototype-pollution guards', () => {
  test('__proto__ as provider returns null without throwing', () => {
    assert.strictEqual(resolveModelPolicy({ provider: '__proto__', budget: 'medium' }, 'sonnet'), null);
  });

  test('constructor as provider returns null without throwing', () => {
    assert.strictEqual(resolveModelPolicy({ provider: 'constructor', budget: 'medium' }, 'sonnet'), null);
  });

  test('__proto__ as budget returns null without throwing', () => {
    assert.strictEqual(resolveModelPolicy({ provider: 'openai', budget: '__proto__' }, 'haiku'), null);
  });

  test('toString as budget returns null without throwing', () => {
    assert.strictEqual(resolveModelPolicy({ provider: 'openai', budget: 'toString' }, 'haiku'), null);
  });

  test('__proto__ as runtime_tiers key returns null without throwing', () => {
    const policy = {
      runtime: '__proto__',
      runtime_tiers: { '__proto__': { haiku: { model: 'evil' } } },
    };
    assert.strictEqual(resolveModelPolicy(policy, 'haiku'), null);
  });

  test('__proto__ as tier inside runtime_tiers returns null without throwing', () => {
    const policy = {
      runtime: 'codex',
      runtime_tiers: { codex: { '__proto__': { model: 'evil' } } },
    };
    assert.strictEqual(resolveModelPolicy(policy, '__proto__'), null);
  });

  test('valid provider+tier+budget still resolves correctly after guards', () => {
    const result = resolveModelPolicy({ provider: 'openai', budget: 'low' }, 'haiku');
    assert.ok(typeof result === 'string' && result.length > 0,
      'valid openai/haiku/low lookup must still resolve after adding hasOwn guards');
  });
});

// ─── resolveModelForTier: model_policy beats dynamic_routing ─────────────────

describe('#49 resolveModelForTier: model_policy beats dynamic_routing', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = makeTmp('for-tier-'); });
  afterEach(() => { rmr(tmpDir); });

  test('model_policy wins over dynamic_routing.tier_models when both are set', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_policy: { provider: 'openai', budget: 'low' },
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
      },
    });
    // model_policy fires before dynamic_routing in resolveModelForTier
    const result = resolveModelForTier(tmpDir, 'gsd-executor', 0);
    // gsd-executor is standard/sonnet tier; openai+low+sonnet preset model
    assert.ok(typeof result === 'string' && result.length > 0,
      'model_policy must return a model string');
    assert.notStrictEqual(result, 'sonnet',
      'dynamic_routing tier alias must not win over model_policy');
  });

  test('model_overrides still beats model_policy in resolveModelForTier', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      model_policy: { provider: 'openai', budget: 'high' },
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
      },
      model_overrides: { 'gsd-planner': 'custom-model-id' },
    });
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-planner', 0), 'custom-model-id');
  });

  test('dynamic_routing.tier_models used normally when model_policy absent', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'my-custom-sonnet', heavy: 'opus' },
      },
    });
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-executor', 0), 'my-custom-sonnet');
  });

  test('model_policy with Claude runtime does not interrupt dynamic_routing', () => {
    // model_policy only gates on non-Claude runtimes; with runtime absent/claude,
    // dynamic_routing must still work normally.
    writeConfig(tmpDir, {
      model_policy: { provider: 'openai', budget: 'low' },
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'my-sonnet', heavy: 'opus' },
      },
    });
    assert.strictEqual(resolveModelForTier(tmpDir, 'gsd-executor', 0), 'my-sonnet');
  });
});
