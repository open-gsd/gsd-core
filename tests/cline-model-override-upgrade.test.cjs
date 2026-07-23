'use strict';

/**
 * cline createAgentModel UPGRADE — ADR-1239 / #2090 AC (upgrade 2).
 *
 * Proves GSD's per-subagent `model_overrides` / `model_profile_overrides`
 * resolution (already used for OpenCode/Codex) now applies to cline subagents
 * via `DefaultGateway.createAgentModel({ providerId, modelId })`, instead of
 * leaving model selection untouched. Cline's `modelMode: active` (the host
 * exposes provider registration via createLlmsRuntime) is what makes this
 * wiring possible — passive hosts can only inject a per-agent model field.
 *
 * The binding resolves the createAgentModel call parameters from GSD config;
 * the real gateway call is the host's responsibility (mocked here, same pattern
 * as tests/fixtures/vscode-host-binding.cjs).
 *
 * Cite:
 *   https://github.com/cline/cline/blob/main/docs/sdk/reference/gateway.mdx
 *     — createAgentModel({ providerId, modelId }) returns an AgentModel
 *   https://github.com/cline/cline/blob/main/sdk/packages/llms/README.md
 *     — createLlmsRuntime(...) provider registry (modelMode: active)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveClineAgentModelParams,
  inferProviderId,
  DEFAULT_CLINE_PROVIDER_ID,
} = require('../gsd-core/bin/lib/host-integration-adapters/cline-sdk-binding.cjs');

// -- upgrade 2: provider inference from a model id --------------------------

test('inferProviderId maps anthropic model ids to "anthropic"', () => {
  assert.equal(inferProviderId('claude-sonnet-4-5'), 'anthropic');
  assert.equal(inferProviderId('claude-opus-4-1'), 'anthropic');
});

test('inferProviderId maps openai model ids to "openai"', () => {
  assert.equal(inferProviderId('gpt-4o'), 'openai');
  assert.equal(inferProviderId('o1-preview'), 'openai');
});

test('inferProviderId falls back to DEFAULT_CLINE_PROVIDER_ID for unknown ids', () => {
  assert.equal(inferProviderId('some-custom-model'), DEFAULT_CLINE_PROVIDER_ID);
  assert.equal(inferProviderId(''), DEFAULT_CLINE_PROVIDER_ID);
});

// -- upgrade 2: model_overrides resolution ----------------------------------

test('a per-agent model_overrides entry resolves to createAgentModel params', () => {
  const result = resolveClineAgentModelParams({
    agentType: 'planner',
    modelOverrides: { planner: 'claude-sonnet-4-5' },
    modelProfileOverrides: null,
    profile: 'balanced',
  });
  assert.deepEqual(result, { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' });
});

test('model_overrides takes precedence over model_profile_overrides', () => {
  const result = resolveClineAgentModelParams({
    agentType: 'planner',
    modelOverrides: { planner: 'claude-sonnet-4-5' },
    modelProfileOverrides: { balanced: { planner: 'claude-opus-4-1' } },
    profile: 'balanced',
  });
  assert.equal(result.modelId, 'claude-sonnet-4-5', 'direct model_overrides wins');
});

test('model_profile_overrides resolves when no direct model_overrides entry exists', () => {
  const result = resolveClineAgentModelParams({
    agentType: 'executor',
    modelOverrides: null,
    modelProfileOverrides: { balanced: { executor: 'gpt-4o' } },
    profile: 'balanced',
  });
  assert.deepEqual(result, { providerId: 'openai', modelId: 'gpt-4o' });
});

// -- upgrade 2: no override → null (gateway default applies) ----------------

test('returns null when no override is configured (gateway picks the default model)', () => {
  const result = resolveClineAgentModelParams({
    agentType: 'planner',
    modelOverrides: null,
    modelProfileOverrides: null,
    profile: 'balanced',
  });
  assert.equal(result, null, 'null = no override; host gateway default applies');
});

test('returns null when the agentType has no matching override', () => {
  const result = resolveClineAgentModelParams({
    agentType: 'planner',
    modelOverrides: { executor: 'claude-sonnet-4-5' },
    modelProfileOverrides: null,
    profile: 'balanced',
  });
  assert.equal(result, null);
});

// -- upgrade 2: the gateway binding (createAgentModel call shape) -----------

test('a resolved override drives DefaultGateway.createAgentModel with the right params', () => {
  // Simulate the host gateway (mocked — the real @cline/sdk is not linked here).
  const calls = [];
  const fakeGateway = {
    createAgentModel(selection) { calls.push(selection); return { providerId: selection.providerId, modelId: selection.modelId }; },
  };
  const params = resolveClineAgentModelParams({
    agentType: 'planner',
    modelOverrides: { planner: 'claude-sonnet-4-5' },
    modelProfileOverrides: null,
    profile: 'balanced',
  });
  assert.ok(params, 'override must resolve to non-null params');
  const model = fakeGateway.createAgentModel(params);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' });
  assert.equal(model.modelId, 'claude-sonnet-4-5');
});

test('no override → createAgentModel is NOT called (gateway default, not GSD override)', () => {
  const calls = [];
  const fakeGateway = {
    createAgentModel(selection) { calls.push(selection); return {}; },
  };
  const params = resolveClineAgentModelParams({
    agentType: 'planner',
    modelOverrides: null,
    modelProfileOverrides: null,
    profile: 'balanced',
  });
  if (params) fakeGateway.createAgentModel(params);
  assert.equal(calls.length, 0, 'no override → gateway must use its own default, GSD does not call createAgentModel');
});

// -- upgrade 2: fail-safe / malformed config --------------------------------

test('malformed override values (non-string) are ignored (fail-safe, not crash)', () => {
  const result = resolveClineAgentModelParams({
    agentType: 'planner',
    modelOverrides: { planner: 42, executor: 'claude-sonnet-4-5' },
    modelProfileOverrides: null,
    profile: 'balanced',
  });
  // planner's non-string override is ignored; falls through to null (no executor match for agentType planner)
  assert.equal(result, null);
});

test('empty-string override is treated as absent', () => {
  const result = resolveClineAgentModelParams({
    agentType: 'planner',
    modelOverrides: { planner: '' },
    modelProfileOverrides: null,
    profile: 'balanced',
  });
  assert.equal(result, null);
});
