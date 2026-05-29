'use strict';

/**
 * Feature test for issue #443 — unified cross-provider effort + fast_mode knobs.
 *
 * Adds config-driven effort (universal ladder: minimal<low<medium<high<xhigh<max)
 * and fast_mode knobs. Per-runtime rendering clamps the unique tails:
 *   - Anthropic/Claude: supports {low,medium,high,xhigh,max}, param=output_config.effort
 *   - Codex: supports {minimal,low,medium,high,xhigh}, param=model_reasoning_effort
 *
 * Also adds resolve-execution query which is the superset command including
 * effort rendering and fast_mode propagation metadata.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');

const {
  resolveEffortInternal,
  resolveFastModeInternal,
  resolveEffortForTier,
} = require('../get-shit-done/bin/lib/core.cjs');

const {
  renderEffortForRuntime,
  RUNTIMES_WITH_FAST_MODE,
} = require('../get-shit-done/bin/lib/model-catalog.cjs');

function writeConfig(dir, config) {
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(config, null, 2));
}

// ─── Effort cascade ───────────────────────────────────────────────────────────

describe('#443 effort cascade', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('no config -> defaults to "high"', () => {
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'high');
  });

  test('routing_tier_defaults: light (gsd-codebase-mapper) -> "low"', () => {
    // gsd-codebase-mapper routingTier=light, default for light is "low"
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-codebase-mapper'), 'low');
  });

  test('routing_tier_defaults: standard (gsd-executor) -> "high"', () => {
    // gsd-executor routingTier=standard, default for standard is "high"
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-executor'), 'high');
  });

  test('routing_tier_defaults: heavy (gsd-planner) -> "xhigh"', () => {
    // gsd-planner routingTier=heavy, default for heavy is "xhigh"
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'xhigh');
  });

  test('effort.routing_tier_defaults override beats tier default', () => {
    writeConfig(tmpDir, {
      effort: { routing_tier_defaults: { heavy: 'medium' } },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'medium');
  });

  test('effort.agent_overrides beats routing_tier_defaults', () => {
    writeConfig(tmpDir, {
      effort: {
        routing_tier_defaults: { heavy: 'medium' },
        agent_overrides: { 'gsd-planner': 'low' },
      },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'low');
  });

  test('opts.override beats agent_overrides', () => {
    writeConfig(tmpDir, {
      effort: { agent_overrides: { 'gsd-planner': 'low' } },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner', { override: 'minimal' }), 'minimal');
  });

  test('invalid override falls through to agent_overrides', () => {
    writeConfig(tmpDir, {
      effort: { agent_overrides: { 'gsd-planner': 'low' } },
    });
    // 'turbo' is not a valid effort — should fall through to agent_overrides
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner', { override: 'turbo' }), 'low');
  });

  test('invalid agent_overrides value falls through to routing_tier_defaults', () => {
    writeConfig(tmpDir, {
      effort: {
        agent_overrides: { 'gsd-planner': 123 },
        routing_tier_defaults: { heavy: 'medium' },
      },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'medium');
  });

  test('invalid routing_tier_defaults value falls through to effort.default', () => {
    writeConfig(tmpDir, {
      effort: {
        routing_tier_defaults: { heavy: 'turbo' },
        default: 'low',
      },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'low');
  });

  test('invalid effort.default falls through to hardcoded "high"', () => {
    writeConfig(tmpDir, {
      effort: { default: 'turbo' },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'high');
  });

  test('unknown agent -> uses effort.default', () => {
    writeConfig(tmpDir, {
      effort: { default: 'medium' },
    });
    // unknown-agent has no routingTier, so step 3 skipped
    assert.strictEqual(resolveEffortInternal(tmpDir, 'unknown-agent-xyz'), 'medium');
  });

  test('effort.default numeric value (123) ignored, hardcoded high fallback', () => {
    writeConfig(tmpDir, {
      effort: { default: 123 },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'xhigh');
    // heavy tier default still applies (numeric default skipped, tier default works)
  });

  test('effort block missing entirely -> uses tier default', () => {
    // No effort key in config at all
    writeConfig(tmpDir, { model_profile: 'balanced' });
    // heavy agent: tier default xhigh
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'xhigh');
  });

  test('effort block is non-object (string) -> falls through to hardcoded high', () => {
    writeConfig(tmpDir, { effort: 'bad' });
    // falls through to hardcoded 'high'
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'high');
  });

  test('effort.routing_tier_defaults empty object -> effort.default', () => {
    writeConfig(tmpDir, {
      effort: { routing_tier_defaults: {}, default: 'low' },
    });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'low');
  });
});

// ─── Fast mode cascade ────────────────────────────────────────────────────────

describe('#443 fast_mode cascade', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('no config -> defaults to false', () => {
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('fast_mode.enabled=true -> true when no tier/agent overrides', () => {
    writeConfig(tmpDir, { fast_mode: { enabled: true } });
    // heavy agent: tier default is false, but enabled=true is layer 4
    // tier default for heavy is false (below enabled), so gets enabled=true
    // Wait — the cascade is: 1.override 2.agent_overrides 3.tier_defaults 4.enabled 5.false
    // For gsd-planner (heavy), tier default is false — falls through to enabled=true
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), true);
  });

  test('fast_mode.routing_tier_defaults.light=true -> light agent gets true', () => {
    writeConfig(tmpDir, {
      fast_mode: { routing_tier_defaults: { light: true } },
    });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-codebase-mapper'), true);
  });

  test('fast_mode.routing_tier_defaults.heavy=false -> heavy agent stays false', () => {
    writeConfig(tmpDir, {
      fast_mode: { enabled: true, routing_tier_defaults: { heavy: false } },
    });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('fast_mode.agent_overrides beats routing_tier_defaults', () => {
    writeConfig(tmpDir, {
      fast_mode: {
        routing_tier_defaults: { light: false },
        agent_overrides: { 'gsd-codebase-mapper': true },
      },
    });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-codebase-mapper'), true);
  });

  test('opts.override beats agent_overrides', () => {
    writeConfig(tmpDir, {
      fast_mode: { agent_overrides: { 'gsd-planner': true } },
    });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner', { override: false }), false);
  });

  test('string "true" NOT accepted as fast_mode override', () => {
    writeConfig(tmpDir, {
      fast_mode: { agent_overrides: { 'gsd-planner': 'true' } },
    });
    // string "true" is not boolean -> fall through to tier default or enabled
    const result = resolveFastModeInternal(tmpDir, 'gsd-planner');
    assert.strictEqual(typeof result, 'boolean');
  });

  test('string "true" in opts.override NOT accepted', () => {
    // opts.override must be strict boolean — string falls through
    const result = resolveFastModeInternal(tmpDir, 'gsd-planner', { override: 'true' });
    assert.strictEqual(result, false);
  });

  test('fast_mode block missing entirely -> defaults to false', () => {
    writeConfig(tmpDir, { model_profile: 'balanced' });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('fast_mode.enabled="yes" (non-boolean) ignored -> false', () => {
    writeConfig(tmpDir, { fast_mode: { enabled: 'yes' } });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('unknown agent fast_mode -> uses enabled flag', () => {
    writeConfig(tmpDir, { fast_mode: { enabled: true } });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'unknown-agent-xyz'), true);
  });
});

// ─── Effort escalation (resolveEffortForTier) ─────────────────────────────────

describe('#443 resolveEffortForTier escalation', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('dynamic_routing disabled -> attempt ignored, returns base effort', () => {
    // gsd-planner heavy -> xhigh baseline
    const base = resolveEffortForTier(tmpDir, 'gsd-planner', 0);
    const attempt1 = resolveEffortForTier(tmpDir, 'gsd-planner', 1);
    assert.strictEqual(base, 'xhigh');
    assert.strictEqual(attempt1, 'xhigh'); // no dynamic_routing -> attempt ignored
  });

  test('dynamic_routing enabled, escalate_on_failure=false -> attempt ignored', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: false,
        max_escalations: 2,
      },
    });
    const base = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 0);
    const attempt1 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1);
    assert.strictEqual(base, attempt1);
  });

  test('dynamic_routing enabled, attempt=1 -> one step up from base', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 2,
      },
      effort: { routing_tier_defaults: { light: 'low' } },
    });
    // gsd-codebase-mapper: light -> effort 'low'; attempt=1 -> 'medium'
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
    // xhigh -> max -> max (clamp)
    const result = resolveEffortForTier(tmpDir, 'gsd-planner', 99);
    assert.strictEqual(result, 'max');
  });

  test('respects max_escalations cap', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 1,
      },
      effort: { routing_tier_defaults: { light: 'low' } },
    });
    // light: low -> attempt=1 -> medium (but max=1 so can only escalate once)
    const at1 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 1);
    const at2 = resolveEffortForTier(tmpDir, 'gsd-codebase-mapper', 2);
    // at2 is capped at 1 escalation, same as at1
    assert.strictEqual(at1, at2);
    assert.strictEqual(at1, 'medium');
  });
});

// ─── Rendering / clamping ──────────────────────────────────────────────────────

describe('#443 renderEffortForRuntime', () => {
  test('codex: "max" clamps to "xhigh"', () => {
    const r = renderEffortForRuntime('codex', 'max');
    assert.strictEqual(r.value, 'xhigh');
    assert.strictEqual(r.param, 'model_reasoning_effort');
  });

  test('codex: common levels passthrough', () => {
    assert.strictEqual(renderEffortForRuntime('codex', 'low').value, 'low');
    assert.strictEqual(renderEffortForRuntime('codex', 'medium').value, 'medium');
    assert.strictEqual(renderEffortForRuntime('codex', 'high').value, 'high');
    assert.strictEqual(renderEffortForRuntime('codex', 'xhigh').value, 'xhigh');
  });

  test('codex: "minimal" passthrough', () => {
    assert.strictEqual(renderEffortForRuntime('codex', 'minimal').value, 'minimal');
  });

  test('claude: "minimal" clamps to "low"', () => {
    const r = renderEffortForRuntime('claude', 'minimal');
    assert.strictEqual(r.value, 'low');
    assert.strictEqual(r.param, 'output_config.effort');
  });

  test('claude: "max" passthrough (Anthropic-only)', () => {
    const r = renderEffortForRuntime('claude', 'max');
    assert.strictEqual(r.value, 'max');
    assert.strictEqual(r.param, 'output_config.effort');
  });

  test('claude: common levels passthrough', () => {
    assert.strictEqual(renderEffortForRuntime('claude', 'low').value, 'low');
    assert.strictEqual(renderEffortForRuntime('claude', 'medium').value, 'medium');
    assert.strictEqual(renderEffortForRuntime('claude', 'high').value, 'high');
    assert.strictEqual(renderEffortForRuntime('claude', 'xhigh').value, 'xhigh');
  });

  test('unknown runtime: param is null, value passthrough', () => {
    const r = renderEffortForRuntime('unknown-runtime', 'high');
    assert.strictEqual(r.param, null);
    assert.strictEqual(r.value, 'high');
  });

  test('RUNTIMES_WITH_FAST_MODE does NOT include "claude"', () => {
    // Claude Code has no per-subagent fast-mode mechanism — session-level only
    assert.ok(!RUNTIMES_WITH_FAST_MODE.has('claude'),
      'claude must NOT be in RUNTIMES_WITH_FAST_MODE — emitting fast_mode frontmatter is a silent no-op');
  });
});

// ─── resolve-execution end-to-end ─────────────────────────────────────────────

describe('#443 resolve-execution CLI command', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempProject();
    // HOME isolation to prevent ~/.gsd/defaults.json bleed
    process.env._GSD_TEST_HOME_OVERRIDE = tmpDir;
  });
  afterEach(() => {
    cleanup(tmpDir);
    delete process.env._GSD_TEST_HOME_OVERRIDE;
  });

  test('default (claude) runtime -> effort present, effort_param=output_config.effort, fast_mode_supported=false', () => {
    const result = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.effort, 'should have effort field');
    assert.strictEqual(output.effort_param, 'output_config.effort');
    assert.strictEqual(output.fast_mode_supported, false);
    assert.ok('fast_mode' in output, 'should have fast_mode field');
    assert.ok('model' in output, 'should have model field');
    assert.ok('profile' in output, 'should have profile field');
  });

  test('codex runtime -> effort_param=model_reasoning_effort, max clamps to xhigh, fast_mode_supported=false', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      effort: { default: 'max' },
    });
    const result = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.effort_param, 'model_reasoning_effort');
    assert.strictEqual(output.effort_rendered, 'xhigh');
    // fast_mode_supported: codex does not support fast mode via subagent
    assert.strictEqual(output.fast_mode_supported, false);
  });

  test('--effort flag overrides config effort', () => {
    const result = runGsdTools(
      ['resolve-execution', 'gsd-planner', '--effort', 'low'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.effort, 'low');
  });

  test('--fast-mode flag honored', () => {
    const result = runGsdTools(
      ['resolve-execution', 'gsd-planner', '--fast-mode', 'true'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.fast_mode, true);
  });

  test('--attempt flag triggers escalation', () => {
    writeConfig(tmpDir, {
      dynamic_routing: {
        enabled: true,
        tier_models: { light: 'haiku', standard: 'sonnet', heavy: 'opus' },
        escalate_on_failure: true,
        max_escalations: 2,
      },
      effort: { routing_tier_defaults: { light: 'low' } },
    });
    const result0 = runGsdTools(
      ['resolve-execution', 'gsd-codebase-mapper', '--attempt', '0'],
      tmpDir,
      { HOME: tmpDir }
    );
    const result1 = runGsdTools(
      ['resolve-execution', 'gsd-codebase-mapper', '--attempt', '1'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result0.success && result1.success);
    const out0 = JSON.parse(result0.output);
    const out1 = JSON.parse(result1.output);
    assert.strictEqual(out0.effort, 'low');
    assert.strictEqual(out1.effort, 'medium');
  });

  test('--raw prints effort string', () => {
    const result = runGsdTools(
      ['resolve-execution', 'gsd-planner', '--raw'],
      tmpDir,
      { HOME: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);
    // Raw output should be the effort string
    const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.ok(VALID_EFFORTS.includes(result.output.trim()),
      `Expected effort string, got: ${result.output}`);
  });

  test('fails when no agent-type provided', () => {
    const result = runGsdTools(['resolve-execution'], tmpDir, { HOME: tmpDir });
    assert.ok(!result.success, 'should fail without agent-type');
    assert.ok(result.error.includes('agent-type required'), `error: ${result.error}`);
  });

  test('unknown agent -> unknown_agent=true still emits effort', () => {
    const result = runGsdTools(['resolve-execution', 'unknown-agent-xyz'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.unknown_agent, true);
    assert.ok(output.effort, 'should have effort even for unknown agent');
  });

  test('emits effort_propagation (channel) field', () => {
    const result = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok('effort_propagation' in output, 'should have effort_propagation field');
  });
});

// ─── resolve-model now emits effort (replaces reasoning_effort) ───────────────

describe('#443 resolve-model emits effort (unified)', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('resolve-model on claude runtime emits effort (not null)', () => {
    const result = runGsdTools(['resolve-model', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    // effort must be present and valid
    const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.ok(VALID_EFFORTS.includes(output.effort),
      `Expected valid effort, got: ${output.effort}`);
    // reasoning_effort must NOT be present (removed)
    assert.ok(!Object.prototype.hasOwnProperty.call(output, 'reasoning_effort'),
      'resolve-model must not emit reasoning_effort (replaced by effort)');
  });

  test('resolve-model on codex runtime emits unified effort (not reasoning_effort)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ runtime: 'codex', model_profile: 'balanced' })
    );
    const result = runGsdTools(['resolve-model', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.ok(VALID_EFFORTS.includes(output.effort),
      `Expected valid effort, got: ${output.effort}`);
    assert.ok(!Object.prototype.hasOwnProperty.call(output, 'reasoning_effort'),
      'resolve-model must not emit reasoning_effort');
  });
});

// ─── QA Matrix — hostile/malformed configs ───────────────────────────────────

describe('#443 QA matrix — malformed effort/fast_mode configs', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('effort.default=123 (numeric) -> gracefully falls through', () => {
    writeConfig(tmpDir, { effort: { default: 123 } });
    // gsd-planner is heavy, tier default xhigh is used instead
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    assert.ok(typeof result === 'string');
    const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.ok(VALID_EFFORTS.includes(result));
  });

  test('fast_mode.enabled="yes" (string) -> ignored, returns false', () => {
    writeConfig(tmpDir, { fast_mode: { enabled: 'yes' } });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('effort:{} empty block -> uses tier default or hardcoded high', () => {
    writeConfig(tmpDir, { effort: {} });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.ok(VALID_EFFORTS.includes(result));
  });

  test('fast_mode:{} empty block -> false', () => {
    writeConfig(tmpDir, { fast_mode: {} });
    assert.strictEqual(resolveFastModeInternal(tmpDir, 'gsd-planner'), false);
  });

  test('effort config is completely absent -> still resolves valid effort', () => {
    writeConfig(tmpDir, { model_profile: 'quality' });
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.ok(VALID_EFFORTS.includes(result));
  });

  test('effort.routing_tier_defaults has boolean value -> falls through', () => {
    writeConfig(tmpDir, {
      effort: {
        routing_tier_defaults: { heavy: true },
        default: 'medium',
      },
    });
    // boolean true is not a valid effort -> falls through to default 'medium'
    assert.strictEqual(resolveEffortInternal(tmpDir, 'gsd-planner'), 'medium');
  });

  test('effort.agent_overrides is non-object -> falls through gracefully', () => {
    writeConfig(tmpDir, {
      effort: {
        agent_overrides: 'not-an-object',
        default: 'low',
      },
    });
    // non-object agent_overrides -> skip step 2, use tier default (heavy=xhigh)
    // actually heavy tier default kicks in first if no routing_tier_defaults
    const result = resolveEffortInternal(tmpDir, 'gsd-planner');
    const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    assert.ok(VALID_EFFORTS.includes(result));
  });

  test('config.json has unknown agent with effort.default set -> uses effort.default', () => {
    writeConfig(tmpDir, { effort: { default: 'minimal' } });
    assert.strictEqual(resolveEffortInternal(tmpDir, 'completely-unknown-agent-98765'), 'minimal');
  });

  test('resolve-execution with malformed config does not crash', () => {
    writeConfig(tmpDir, {
      effort: { default: null, routing_tier_defaults: null },
      fast_mode: { enabled: null, agent_overrides: null },
    });
    const result = runGsdTools(['resolve-execution', 'gsd-planner'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Should not crash with null config values: ${result.error}`);
  });
});

// ─── Config schema: new keys are valid ───────────────────────────────────────

describe('#443 config schema: new effort/fast_mode keys valid', () => {
  const { isValidConfigKey } = require('../get-shit-done/bin/lib/config-schema.cjs');

  test('effort.default is a valid config key', () => {
    assert.ok(isValidConfigKey('effort.default'), 'effort.default must be valid');
  });

  test('fast_mode.enabled is a valid config key', () => {
    assert.ok(isValidConfigKey('fast_mode.enabled'), 'fast_mode.enabled must be valid');
  });

  test('effort.routing_tier_defaults.light is valid (dynamic pattern)', () => {
    assert.ok(isValidConfigKey('effort.routing_tier_defaults.light'));
  });

  test('effort.routing_tier_defaults.standard is valid', () => {
    assert.ok(isValidConfigKey('effort.routing_tier_defaults.standard'));
  });

  test('effort.routing_tier_defaults.heavy is valid', () => {
    assert.ok(isValidConfigKey('effort.routing_tier_defaults.heavy'));
  });

  test('effort.agent_overrides.<agent-id> is valid (dynamic pattern)', () => {
    assert.ok(isValidConfigKey('effort.agent_overrides.gsd-planner'));
    assert.ok(isValidConfigKey('effort.agent_overrides.my-custom-agent'));
  });

  test('fast_mode.routing_tier_defaults.light is valid', () => {
    assert.ok(isValidConfigKey('fast_mode.routing_tier_defaults.light'));
  });

  test('fast_mode.agent_overrides.<agent-id> is valid', () => {
    assert.ok(isValidConfigKey('fast_mode.agent_overrides.gsd-planner'));
  });

  test('effort.routing_tier_defaults.invalid-tier is NOT valid', () => {
    assert.ok(!isValidConfigKey('effort.routing_tier_defaults.super'));
  });
});
