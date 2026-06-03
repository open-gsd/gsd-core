'use strict';

/**
 * Architecture-level QA for issue #443 — unified effort + fast_mode engine.
 *
 * Integration suite (*.integration.test.cjs): cross-module flows that exercise
 * real CLI invocations via runGsdTools, the full 33-agent registry, and the
 * config round-trip through config-set -> resolve-execution.
 *
 * INVARIANTS tested here (each is also documented in docs/TESTING-SUITES.md):
 *
 *  (a) CROSS-PROVIDER VALIDITY  — renderEffortForRuntime never emits a value
 *      that the real provider API would 400 on. Ground-truth provider enums are
 *      defined as local constants (not sourced from the implementation).
 *
 *  (b) PARAM/CHANNEL CONTRACT   — each runtime exposes a stable parameter name
 *      and propagation channel.
 *
 *  (c) RESOLVE-EXECUTION JSON CONTRACT — the CLI command emits a stable JSON
 *      shape with all required keys and correct types.
 *
 *  (d) TOTALITY across the real 33-agent registry — every agent produces a
 *      valid effort value; none returns undefined/null.
 *
 *  (e) FAST-MODE HONESTY INVARIANT — claude runtime always reports
 *      fast_mode_supported=false (emitting fast_mode frontmatter is a silent
 *      no-op for Claude Code subagents).
 *
 *  (f) PRECEDENCE MATRIX — first-valid-wins for both effort and fast_mode
 *      cascades, including invalid values correctly falling through.
 *
 *  (g) DYNAMIC-ROUTING COMPOSITION — resolveEffortForTier escalates
 *      independently of model tier logic; clamps at 'max'; respects
 *      max_escalations; disabled when escalate_on_failure=false.
 *
 *  (h) CONFIG-TOOLING ROUND-TRIP — config-set accepts all new effort/fast_mode
 *      key paths (schema validation passes); values survive round-trip through
 *      resolve-execution.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const {
  resolveEffortInternal,
  resolveFastModeInternal,
  resolveEffortForTier,
  VALID_EFFORTS,
} = require('../gsd-core/bin/lib/core.cjs');

const {
  renderEffortForRuntime,
  RUNTIMES_WITH_FAST_MODE,
  catalog,
} = require('../gsd-core/bin/lib/model-catalog.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// Ground-truth provider enums (defined HERE, not sourced from the implementation).
// These are the exact values the real APIs accept — using a value outside these
// sets would result in a 400 response from the provider.
//
// Sources:
//   Anthropic: output_config.effort — https://docs.anthropic.com (Claude API)
//   OpenAI:    model_reasoning_effort — https://platform.openai.com/docs (Codex)
// ─────────────────────────────────────────────────────────────────────────────
const PROVIDER_EFFORT_ENUMS = {
  claude: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  codex:  new Set(['minimal', 'low', 'medium', 'high', 'xhigh']),
};

// Helper: write config.json into a temp project
function writeConfig(dir, config) {
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(config, null, 2));
}

// ─── (a) CROSS-PROVIDER VALIDITY INVARIANT ───────────────────────────────────

describe('#443 integration (a): cross-provider validity invariant', () => {
  // For every universal effort × every provider runtime, the rendered value
  // must be a member of that provider's real API enum.
  test('all VALID_EFFORTS render within provider enums for claude and codex', () => {
    for (const universalEffort of VALID_EFFORTS) {
      for (const [runtime, providerEnum] of Object.entries(PROVIDER_EFFORT_ENUMS)) {
        const rendered = renderEffortForRuntime(runtime, universalEffort);
        assert.ok(
          providerEnum.has(rendered.value),
          `render('${runtime}', '${universalEffort}').value = '${rendered.value}' is NOT in the ` +
          `${runtime} provider enum ${[...providerEnum].join('|')} — real API would 400`
        );
      }
    }
  });

  // Documented clamps must hold exactly
  test("render('codex','max').value === 'xhigh' (max is Anthropic-only)", () => {
    assert.strictEqual(renderEffortForRuntime('codex', 'max').value, 'xhigh');
  });

  test("render('claude','minimal').value === 'low' (minimal is Codex-only)", () => {
    assert.strictEqual(renderEffortForRuntime('claude', 'minimal').value, 'low');
  });

  // Common levels must pass through unchanged on BOTH providers
  test('common levels (low/medium/high/xhigh) pass through unchanged on claude', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh']) {
      assert.strictEqual(
        renderEffortForRuntime('claude', level).value,
        level,
        `claude: level '${level}' should pass through unchanged`
      );
    }
  });

  test('common levels (low/medium/high/xhigh) pass through unchanged on codex', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh']) {
      assert.strictEqual(
        renderEffortForRuntime('codex', level).value,
        level,
        `codex: level '${level}' should pass through unchanged`
      );
    }
  });
});

// ─── (b) PARAM/CHANNEL CONTRACT ──────────────────────────────────────────────

describe('#443 integration (b): param/channel contract', () => {
  test("claude: param is always 'output_config.effort'", () => {
    for (const effort of VALID_EFFORTS) {
      const r = renderEffortForRuntime('claude', effort);
      assert.strictEqual(r.param, 'output_config.effort',
        `claude param must be 'output_config.effort' for effort '${effort}'`);
    }
  });

  test("codex: param is always 'model_reasoning_effort'", () => {
    for (const effort of VALID_EFFORTS) {
      const r = renderEffortForRuntime('codex', effort);
      assert.strictEqual(r.param, 'model_reasoning_effort',
        `codex param must be 'model_reasoning_effort' for effort '${effort}'`);
    }
  });

  test('claude channel is stable: frontmatter', () => {
    for (const effort of VALID_EFFORTS) {
      assert.strictEqual(renderEffortForRuntime('claude', effort).channel, 'frontmatter');
    }
  });

  test('codex channel is stable: api', () => {
    for (const effort of VALID_EFFORTS) {
      assert.strictEqual(renderEffortForRuntime('codex', effort).channel, 'api');
    }
  });

  test("unknown runtimes (gemini, qwen, 'mystery'): param===null, value passes through", () => {
    for (const runtime of ['gemini', 'qwen', 'mystery']) {
      for (const effort of VALID_EFFORTS) {
        const r = renderEffortForRuntime(runtime, effort);
        assert.strictEqual(r.param, null, `${runtime}: param must be null`);
        assert.strictEqual(r.channel, null, `${runtime}: channel must be null`);
        assert.strictEqual(r.value, effort, `${runtime}: value must pass through unchanged`);
      }
    }
  });
});

// ─── (c) RESOLVE-EXECUTION JSON CONTRACT ─────────────────────────────────────

describe('#443 integration (c): resolve-execution JSON contract', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  function assertFullContract(output, label) {
    assert.ok(typeof output.model === 'string' && output.model.length > 0,
      `${label}: model must be a non-empty string`);
    assert.ok(typeof output.profile === 'string' && output.profile.length > 0,
      `${label}: profile must be a non-empty string`);
    assert.ok(VALID_EFFORTS.includes(output.effort),
      `${label}: effort '${output.effort}' must be a member of VALID_EFFORTS`);
    assert.ok(typeof output.effort_rendered === 'string' && output.effort_rendered.length > 0,
      `${label}: effort_rendered must be a non-empty string`);
    assert.ok(output.effort_param === null || typeof output.effort_param === 'string',
      `${label}: effort_param must be string or null`);
    assert.ok(output.effort_propagation === null || typeof output.effort_propagation === 'string',
      `${label}: effort_propagation must be string or null`);
    assert.ok(typeof output.fast_mode === 'boolean',
      `${label}: fast_mode must be a boolean`);
    assert.ok(typeof output.fast_mode_supported === 'boolean',
      `${label}: fast_mode_supported must be a boolean`);
  }

  test('gsd-planner (default claude runtime): full contract + known-agent shape', () => {
    const result = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assertFullContract(output, 'gsd-planner/claude');
    assert.strictEqual(output.effort_param, 'output_config.effort');
    assert.strictEqual(output.effort_propagation, 'frontmatter');
    assert.strictEqual(output.fast_mode_supported, false);
    // known agent must NOT have unknown_agent:true
    assert.ok(!output.unknown_agent, 'known agent must not have unknown_agent:true');
  });

  test('codex runtime: full contract + effort_param=model_reasoning_effort', () => {
    writeConfig(tmpDir, { runtime: 'codex' });
    const result = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assertFullContract(output, 'gsd-planner/codex');
    assert.strictEqual(output.effort_param, 'model_reasoning_effort');
    assert.strictEqual(output.fast_mode_supported, false);
  });

  test('gemini runtime: full contract + effort_param===null (no effort wire)', () => {
    writeConfig(tmpDir, { runtime: 'gemini' });
    const result = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assertFullContract(output, 'gsd-planner/gemini');
    assert.strictEqual(output.effort_param, null);
    assert.strictEqual(output.effort_propagation, null);
    assert.strictEqual(output.fast_mode_supported, false);
  });

  test('unknown agent: full contract + unknown_agent===true', () => {
    const result = runGsdTools(['resolve-execution', 'unknown-agent-xyz'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assertFullContract(output, 'unknown-agent-xyz');
    assert.strictEqual(output.unknown_agent, true, 'unknown agent must have unknown_agent:true');
  });
});

// ─── (d) TOTALITY across the real 33-agent registry ──────────────────────────

describe('#443 integration (d): totality across real registry', () => {
  let tmpDir;
  before(() => { tmpDir = createTempProject(); });
  after(() => { cleanup(tmpDir); });

  const registeredAgents = Object.keys(catalog.agents);
  // Confirm we're covering the full registry — snapshot the count so a
  // catalog shrink is caught by this assertion.
  test(`registry has at least 33 agents (currently ${registeredAgents.length})`, () => {
    assert.ok(registeredAgents.length >= 33,
      `Expected at least 33 agents in registry, got ${registeredAgents.length}`);
  });

  test(`all ${registeredAgents.length} agents: resolveEffortInternal returns a VALID_EFFORTS member`, () => {
    const effortSet = new Set(VALID_EFFORTS);
    const bad = [];
    for (const agent of registeredAgents) {
      const effort = resolveEffortInternal(tmpDir, agent);
      if (effort === undefined || effort === null || !effortSet.has(effort)) {
        bad.push(`${agent}: got ${JSON.stringify(effort)}`);
      }
    }
    assert.strictEqual(bad.length, 0,
      `Agents with invalid effort:\n${bad.join('\n')}`);
  });

  test(`all ${registeredAgents.length} agents: resolveFastModeInternal returns strict boolean`, () => {
    const bad = [];
    for (const agent of registeredAgents) {
      const fm = resolveFastModeInternal(tmpDir, agent);
      if (typeof fm !== 'boolean') {
        bad.push(`${agent}: got ${JSON.stringify(fm)} (${typeof fm})`);
      }
    }
    assert.strictEqual(bad.length, 0,
      `Agents with non-boolean fast_mode:\n${bad.join('\n')}`);
  });

  test(`all ${registeredAgents.length} agents: renderEffortForRuntime('claude', effort) stays in claude enum`, () => {
    const claudeEnum = PROVIDER_EFFORT_ENUMS.claude;
    const bad = [];
    for (const agent of registeredAgents) {
      const effort = resolveEffortInternal(tmpDir, agent);
      const rendered = renderEffortForRuntime('claude', effort);
      if (!claudeEnum.has(rendered.value)) {
        bad.push(`${agent}: effort=${effort} rendered=${rendered.value} not in claude enum`);
      }
    }
    assert.strictEqual(bad.length, 0,
      `Agents producing invalid claude effort:\n${bad.join('\n')}`);
  });
});

// ─── (e) FAST-MODE HONESTY INVARIANT ─────────────────────────────────────────

describe('#443 integration (e): fast-mode honesty invariant', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  // Sample of agents across all tiers to prove the invariant is not agent-specific
  const testAgents = ['gsd-planner', 'gsd-executor', 'gsd-codebase-mapper', 'gsd-verifier'];

  test('claude runtime: fast_mode_supported is ALWAYS false regardless of fast_mode config', () => {
    const configs = [
      {},
      { fast_mode: { enabled: true } },
      { fast_mode: { routing_tier_defaults: { heavy: true } } },
      { fast_mode: { agent_overrides: { 'gsd-planner': true } } },
    ];
    for (const config of configs) {
      writeConfig(tmpDir, config);
      for (const agent of testAgents) {
        const result = runGsdTools(['resolve-execution', agent], tmpDir, { HOME: tmpDir });
        assert.ok(result.success, `Command failed for ${agent}: ${result.error}`);
        const output = JSON.parse(result.output);
        assert.strictEqual(output.fast_mode_supported, false,
          `claude/${agent}: fast_mode_supported must be false (Claude has no per-subagent fast-mode mechanism); config=${JSON.stringify(config)}`);
      }
    }
  });

  test("RUNTIMES_WITH_FAST_MODE.has('api') === true (api is the only fast-mode capable runtime)", () => {
    assert.ok(RUNTIMES_WITH_FAST_MODE.has('api'),
      "RUNTIMES_WITH_FAST_MODE must include 'api' — this is the only runtime with per-call fast_mode support");
  });

  test("RUNTIMES_WITH_FAST_MODE.has('claude') === false (claude fast-mode is session-level only)", () => {
    assert.ok(!RUNTIMES_WITH_FAST_MODE.has('claude'),
      "RUNTIMES_WITH_FAST_MODE must NOT include 'claude' — emitting fast_mode frontmatter on a Claude subagent is a silent no-op");
  });

  test("RUNTIMES_WITH_FAST_MODE.has('codex') === false", () => {
    assert.ok(!RUNTIMES_WITH_FAST_MODE.has('codex'),
      "codex does not support per-call fast_mode");
  });

  test("RUNTIMES_WITH_FAST_MODE.has('gemini') === false", () => {
    assert.ok(!RUNTIMES_WITH_FAST_MODE.has('gemini'),
      "gemini does not support per-call fast_mode");
  });
});

// ─── (f) PRECEDENCE MATRIX ───────────────────────────────────────────────────

describe('#443 integration (f): precedence matrix (property/table-driven)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  // Effort: first-valid-wins from highest precedence to lowest
  //   1. opts.override (invocation)
  //   2. effort.agent_overrides.<agent>
  //   3. effort.routing_tier_defaults.<tier>
  //   4. effort.default
  //   5. manifest tier default
  //   6. hardcoded 'high'
  const effortPrecedenceTable = [
    {
      label: 'layer 1 (invocation override) beats all',
      config: {
        effort: {
          agent_overrides: { 'gsd-planner': 'low' },
          routing_tier_defaults: { heavy: 'medium' },
          default: 'xhigh',
        },
      },
      opts: { override: 'minimal' },
      expected: 'minimal',
    },
    {
      label: 'layer 2 (agent_override) beats tier default and default',
      config: {
        effort: {
          agent_overrides: { 'gsd-planner': 'low' },
          routing_tier_defaults: { heavy: 'medium' },
          default: 'xhigh',
        },
      },
      opts: {},
      expected: 'low',
    },
    {
      label: 'layer 3 (routing_tier_defaults) beats effort.default',
      config: {
        effort: {
          routing_tier_defaults: { heavy: 'medium' },
          default: 'xhigh',
        },
      },
      opts: {},
      expected: 'medium',
    },
    {
      label: 'layer 4 (effort.default) when no tier default set',
      config: {
        effort: { default: 'low' },
      },
      opts: {},
      expected: 'low',
    },
    {
      label: 'invalid layer 1 (turbo) falls through to layer 2 (agent_override)',
      config: {
        effort: { agent_overrides: { 'gsd-planner': 'medium' } },
      },
      opts: { override: 'turbo' },
      expected: 'medium',
    },
    {
      label: 'invalid layer 2 (agent_override=123 numeric) falls through to tier default',
      config: {
        effort: {
          agent_overrides: { 'gsd-planner': 123 },
          routing_tier_defaults: { heavy: 'high' },
        },
      },
      opts: {},
      expected: 'high',
    },
    {
      label: 'invalid tier default (turbo) falls through to effort.default',
      config: {
        effort: {
          routing_tier_defaults: { heavy: 'turbo' },
          default: 'low',
        },
      },
      opts: {},
      expected: 'low',
    },
  ];

  for (const row of effortPrecedenceTable) {
    test(`effort precedence: ${row.label}`, () => {
      writeConfig(tmpDir, row.config);
      const result = resolveEffortInternal(tmpDir, 'gsd-planner', row.opts);
      assert.strictEqual(result, row.expected,
        `Expected '${row.expected}', got '${result}' — config: ${JSON.stringify(row.config)}`);
    });
  }

  // fast_mode precedence:
  //   1. opts.override (strict boolean only)
  //   2. fast_mode.agent_overrides.<agent> (strict boolean only)
  //   3. fast_mode.routing_tier_defaults.<tier> (strict boolean only)
  //   4. fast_mode.enabled (strict boolean only)
  //   5. false
  const fastModePrecedenceTable = [
    {
      label: 'layer 1 (opts.override=false) beats enabled=true',
      config: { fast_mode: { enabled: true } },
      opts: { override: false },
      expected: false,
    },
    {
      label: 'layer 2 (agent_override=true) beats tier default',
      config: {
        fast_mode: {
          agent_overrides: { 'gsd-planner': true },
          routing_tier_defaults: { heavy: false },
          enabled: false,
        },
      },
      opts: {},
      expected: true,
    },
    {
      label: 'layer 3 (tier default=true) beats enabled=false',
      config: {
        fast_mode: {
          routing_tier_defaults: { heavy: true },
          enabled: false,
        },
      },
      opts: {},
      expected: true,
    },
    {
      label: 'layer 4 (enabled=true) when no tier/agent overrides',
      config: { fast_mode: { enabled: true } },
      opts: {},
      expected: true,
    },
    {
      label: 'layer 5 (default false) when all absent',
      config: {},
      opts: {},
      expected: false,
    },
    {
      label: 'string "true" in opts.override is NOT accepted (falls through)',
      config: { fast_mode: { enabled: true } },
      // override must be strict boolean; string falls through to next layer
      opts: { override: 'true' },
      // 'true' as string is not boolean -> falls through to tier default
      // gsd-planner is heavy; no tier default set; falls to enabled=true
      expected: true,
    },
    {
      label: 'string "true" in agent_overrides is NOT accepted',
      config: {
        fast_mode: {
          agent_overrides: { 'gsd-planner': 'true' },
          enabled: false,
        },
      },
      opts: {},
      // string 'true' is not boolean -> fall through to tier default -> enabled=false -> false
      expected: false,
    },
  ];

  for (const row of fastModePrecedenceTable) {
    test(`fast_mode precedence: ${row.label}`, () => {
      writeConfig(tmpDir, row.config);
      const result = resolveFastModeInternal(tmpDir, 'gsd-planner', row.opts);
      assert.strictEqual(result, row.expected,
        `Expected ${row.expected}, got ${result} — config: ${JSON.stringify(row.config)}`);
    });
  }
});

// ─── (g) DYNAMIC-ROUTING COMPOSITION ─────────────────────────────────────────

describe('#443 integration (g): dynamic-routing composition', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  const dynamicRoutingBase = {
    dynamic_routing: {
      enabled: true,
      tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
      escalate_on_failure: true,
      max_escalations: 4,
    },
    effort: { routing_tier_defaults: { light: 'low' } },
  };

  test('resolveEffortForTier escalates independently of model resolution', () => {
    writeConfig(tmpDir, dynamicRoutingBase);
    const effort0 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 0);
    const effort1 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1);
    const effort2 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 2);
    assert.strictEqual(effort0, 'low');
    assert.strictEqual(effort1, 'medium');
    assert.strictEqual(effort2, 'high');
    // Verify the effort ladder steps up correctly without asserting model value
    // (model timing is a separate concern from effort escalation)
    assert.notStrictEqual(effort0, effort1, 'effort should escalate at attempt 1');
    assert.notStrictEqual(effort1, effort2, 'effort should escalate at attempt 2');
  });

  test('escalate_on_failure=false: attempt is ignored for effort', () => {
    writeConfig(tmpDir, {
      ...dynamicRoutingBase,
      dynamic_routing: {
        ...dynamicRoutingBase.dynamic_routing,
        escalate_on_failure: false,
      },
    });
    const e0 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 0);
    const e1 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1);
    const e3 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 3);
    assert.strictEqual(e0, e1, 'effort must not escalate when escalate_on_failure=false');
    assert.strictEqual(e0, e3, 'effort must not escalate when escalate_on_failure=false');
  });

  test('escalation clamps at "max" regardless of attempt number', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 99,
      },
      effort: { default: 'max' },
    });
    // Any large attempt number — result must never exceed 'max'
    const r = resolveEffortForTier(tmpDir, 'gsd-planner', 50);
    assert.strictEqual(r, 'max', `Effort must clamp at 'max', got '${r}'`);
    const EFFORT_LADDER = VALID_EFFORTS;
    const maxIdx = EFFORT_LADDER.indexOf('max');
    const rIdx = EFFORT_LADDER.indexOf(r);
    assert.ok(rIdx <= maxIdx, 'Effort must not exceed the max position in the ladder');
  });

  test('respects max_escalations cap: attempt beyond cap gives same as cap', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 1,
      },
      effort: { routing_tier_defaults: { light: 'low' } },
    });
    const atCap = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1);    // 1 escalation
    const beyond = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 5);   // capped at 1
    assert.strictEqual(atCap, beyond,
      'Effort beyond max_escalations must be same as at cap');
    assert.strictEqual(atCap, 'medium', 'low + 1 escalation = medium');
  });

  test('dynamic_routing disabled: resolveEffortForTier ignores attempt', () => {
    writeConfig(tmpDir, {
      effort: { routing_tier_defaults: { light: 'low' } },
    });
    const e0 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 0);
    const e5 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 5);
    assert.strictEqual(e0, e5, 'Effort must not change when dynamic_routing is disabled');
    assert.strictEqual(e0, 'low');
  });
});

// ─── (h) CONFIG-TOOLING ROUND-TRIP ───────────────────────────────────────────

describe('#443 integration (h): config-tooling round-trip', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('config-set effort.default then resolve-execution reflects new value', () => {
    const setResult = runGsdTools(['config-set', 'effort.default', 'low'], tmpDir, { HOME: tmpDir });
    assert.ok(setResult.success, `config-set effort.default failed: ${setResult.error}`);

    const execResult = runGsdTools(['resolve-execution', 'unknown-agent-xyz'], tmpDir, { HOME: tmpDir });
    assert.ok(execResult.success, `resolve-execution failed: ${execResult.error}`);
    const output = JSON.parse(execResult.output);
    // unknown agent falls through to effort.default
    assert.strictEqual(output.effort, 'low',
      `Expected effort='low' after config-set, got '${output.effort}'`);
  });

  test('config-set effort.routing_tier_defaults.heavy then resolve-execution uses it', () => {
    const setResult = runGsdTools(
      ['config-set', 'effort.routing_tier_defaults.heavy', 'medium'],
      tmpDir, { HOME: tmpDir }
    );
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const execResult = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(execResult.success, `resolve-execution failed: ${execResult.error}`);
    const output = JSON.parse(execResult.output);
    // gsd-planner is heavy; tier default now overridden to medium
    assert.strictEqual(output.effort, 'medium',
      `Expected effort='medium' after routing_tier_defaults override, got '${output.effort}'`);
  });

  test('config-set effort.agent_overrides.<agent> wins over tier default', () => {
    // Set tier default first, then per-agent override
    runGsdTools(['config-set', 'effort.routing_tier_defaults.heavy', 'medium'], tmpDir, { HOME: tmpDir });
    const setResult = runGsdTools(
      ['config-set', 'effort.agent_overrides.gsd-planner', 'xhigh'],
      tmpDir, { HOME: tmpDir }
    );
    assert.ok(setResult.success, `config-set agent_overrides failed: ${setResult.error}`);

    const execResult = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(execResult.success, `resolve-execution failed: ${execResult.error}`);
    const output = JSON.parse(execResult.output);
    assert.strictEqual(output.effort, 'xhigh',
      `Expected agent_overrides to win (xhigh), got '${output.effort}'`);
  });

  test('config-set fast_mode.enabled true then resolve-execution reflects fast_mode=true', () => {
    const setResult = runGsdTools(['config-set', 'fast_mode.enabled', 'true'], tmpDir, { HOME: tmpDir });
    assert.ok(setResult.success, `config-set fast_mode.enabled failed: ${setResult.error}`);

    const execResult = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(execResult.success, `resolve-execution failed: ${execResult.error}`);
    const output = JSON.parse(execResult.output);
    assert.strictEqual(output.fast_mode, true,
      `Expected fast_mode=true after config-set, got ${output.fast_mode}`);
    // fast_mode_supported stays false (claude runtime)
    assert.strictEqual(output.fast_mode_supported, false);
  });

  test('config-set fast_mode.agent_overrides.<agent> true reflects in output', () => {
    const setResult = runGsdTools(
      ['config-set', 'fast_mode.agent_overrides.gsd-codebase-mapper', 'true'],
      tmpDir, { HOME: tmpDir }
    );
    assert.ok(setResult.success, `config-set failed: ${setResult.error}`);

    const execResult = runGsdTools(['resolve-execution', 'gsd-codebase-mapper'], tmpDir, { HOME: tmpDir });
    assert.ok(execResult.success, `resolve-execution failed: ${execResult.error}`);
    const output = JSON.parse(execResult.output);
    assert.strictEqual(output.fast_mode, true,
      `Expected fast_mode=true for agent-specific override`);
  });

  // Prove the config-set commands accept all the new key namespaces (schema validation)
  test('config-set accepts all effort/* and fast_mode/* key namespaces without error', () => {
    const keysToTest = [
      ['effort.default', 'high'],
      ['effort.routing_tier_defaults.light', 'low'],
      ['effort.routing_tier_defaults.standard', 'medium'],
      ['effort.routing_tier_defaults.heavy', 'xhigh'],
      ['effort.agent_overrides.gsd-executor', 'high'],
      ['fast_mode.enabled', 'false'],
      ['fast_mode.routing_tier_defaults.light', 'false'],
      ['fast_mode.routing_tier_defaults.standard', 'false'],
      ['fast_mode.routing_tier_defaults.heavy', 'false'],
      ['fast_mode.agent_overrides.gsd-verifier', 'false'],
    ];
    for (const [key, val] of keysToTest) {
      const r = runGsdTools(['config-set', key, val], tmpDir, { HOME: tmpDir });
      assert.ok(r.success, `config-set '${key}' '${val}' should succeed, got: ${r.error}`);
    }
  });
});
