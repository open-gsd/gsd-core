'use strict';

/**
 * pi upgrades — ADR-1239 Phase D / #2102 Stage 2 (EoS/pi).
 *
 * Mirrors tests/opencode-imperative-reference.test.cjs's structure (Host-
 * Integration axes classification/negotiation + the Context7-verified
 * upgrades) for pi's three additive upgrades:
 *   1. EXTENSION_EVENT_SURFACES.pi — the full ~30-event ExtensionAPI surface
 *      (was a single-event ['tool_call'] placeholder).
 *   2. Event bindings — pi/gsd.cjs actually binds session_start,
 *      before_agent_start, session_before_compact (+ tool_call) via pi.on(),
 *      not just declaring the surface in host-integration.cts.
 *   3. Active-model steering — before_provider_request resolves GSD's
 *      tier→model via the model-catalog's pi entries (populated this stage)
 *      and returns a bare anthropic model id pi's built-in models accept;
 *      fails open (returns undefined) when resolution comes back null.
 *
 * Plus the command-surface completions (getArgumentCompletions) and the
 * standard fail-closed negotiation guarantee.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  extensionEventSurfaceFor,
  negotiateHostCapabilities,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');
const { RUNTIME_PROFILE_MAP } = require('../gsd-core/bin/lib/model-catalog.cjs');

const gsdPiExtension = require('../pi/gsd.cjs');
const { _internals } = require('../pi/gsd.cjs');

const PI_CAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'pi', 'capability.json'), 'utf8'),
);
const PI_AXES = PI_CAP.runtime.hostIntegration;

function mockPi() {
  const recorded = { commands: {}, tools: {}, events: {} };
  return {
    registerCommand(name, def) { recorded.commands[name] = def; },
    registerTool(def) { if (def && def.name) recorded.tools[def.name] = def; },
    registerProvider() {
      throw new Error('gsdPiExtension must NOT call registerProvider — GSD steers pi\'s existing anthropic models, it does not add a new provider');
    },
    on(event, handler) { (recorded.events[event] = recorded.events[event] || []).push(handler); },
    _recorded: recorded,
  };
}

// -- (1) EXTENSION_EVENT_SURFACES.pi has all 30 events -----------------------

const EXPECTED_PI_EVENTS = [
  'session_start', 'project_trust', 'resources_discover', 'input',
  'before_agent_start', 'agent_start', 'message_start', 'message_update',
  'message_end', 'turn_start', 'context', 'before_provider_request',
  'after_provider_response', 'tool_execution_start', 'tool_execution_update',
  'tool_execution_end', 'tool_call', 'tool_result', 'turn_end', 'agent_end',
  'session_before_switch', 'session_shutdown', 'session_before_fork',
  'session_info_changed', 'session_before_compact', 'session_compact',
  'session_before_tree', 'session_tree', 'thinking_level_select', 'model_select',
];

test('pi extension-event surface declares all 30 documented ExtensionAPI events (#2102)', () => {
  const surface = extensionEventSurfaceFor('pi');
  assert.ok(surface, 'pi is a consumed extensionEvents dialect');
  assert.equal(surface.length, 30, `expected exactly 30 events, got ${surface.length}`);
  for (const ev of EXPECTED_PI_EVENTS) {
    assert.ok(surface.includes(ev), `expected pi extension-event surface to include "${ev}"`);
  }
  assert.deepEqual([...surface].sort(), [...EXPECTED_PI_EVENTS].sort());
});

// -- (2) the binding actually binds session_start/before_agent_start/ -------
//        session_before_compact (not just declared in host-integration.cts)

test('gsdPiExtension binds session_start, before_agent_start, session_before_compact, tool_call, before_provider_request', () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  for (const ev of ['session_start', 'before_agent_start', 'session_before_compact', 'tool_call', 'before_provider_request']) {
    assert.ok(Array.isArray(pi._recorded.events[ev]) && pi._recorded.events[ev].length > 0,
      `expected gsdPiExtension to bind pi.on("${ev}", ...)`);
  }
});

test('gsdPiExtension does NOT call registerProvider (GSD steers pi\'s existing anthropic models, not a new provider)', () => {
  const pi = mockPi();
  // If gsdPiExtension called registerProvider, mockPi's registerProvider throws.
  assert.doesNotThrow(() => gsdPiExtension(pi));
});

// Finding #3 (adversarial review): the tests below previously only exercised
// buildBeforeProviderRequestHandler() directly (the builder), never the
// handler ACTUALLY REGISTERED via pi.on('before_provider_request', ...) in
// gsdPiExtension. This ties the bound handler (default tier = 'sonnet') to
// the real model-catalog steering end-to-end.
test('the ACTUALLY-REGISTERED before_provider_request handler steers to the default-tier model-catalog pi id', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const boundHandler = pi._recorded.events['before_provider_request'][0];
  assert.equal(typeof boundHandler, 'function');

  const out = await boundHandler({ payload: {} }, { cwd: __dirname });
  assert.ok(out, 'expected a modified payload, not undefined');
  assert.equal(out.model, RUNTIME_PROFILE_MAP.pi.sonnet.model, 'the bound handler steers to the default (sonnet) tier\'s model-catalog pi id');
  assert.equal(out.model, 'claude-sonnet-5');
});

// -- (3) before_provider_request: active-model steering ----------------------

test('before_provider_request resolves a tier that maps to a model → returns a payload with the bare anthropic model id (model-catalog pi ids)', async () => {
  const handler = _internals.buildBeforeProviderRequestHandler({ tier: 'sonnet' });
  const result = await handler({ payload: { existing: 'field' } }, { cwd: __dirname });
  assert.ok(result, 'expected a modified payload, not undefined');
  assert.equal(result.existing, 'field', 'original payload fields are preserved');
  assert.equal(result.model, RUNTIME_PROFILE_MAP.pi.sonnet.model, 'model id matches the model-catalog pi entry');
  assert.equal(result.model, 'claude-sonnet-5');
});

test('before_provider_request resolves opus/haiku tiers to their model-catalog pi ids too', async () => {
  const opusHandler = _internals.buildBeforeProviderRequestHandler({ tier: 'opus' });
  const opusResult = await opusHandler({ payload: {} }, { cwd: __dirname });
  assert.equal(opusResult.model, RUNTIME_PROFILE_MAP.pi.opus.model);

  const haikuHandler = _internals.buildBeforeProviderRequestHandler({ tier: 'haiku' });
  const haikuResult = await haikuHandler({ payload: {} }, { cwd: __dirname });
  assert.equal(haikuResult.model, RUNTIME_PROFILE_MAP.pi.haiku.model);
});

test('before_provider_request given a tier that resolves to null returns undefined (fail-open, never a wrong/empty id)', async () => {
  const handler = _internals.buildBeforeProviderRequestHandler({ tier: 'not-a-real-tier-8675309' });
  const result = await handler({ payload: { existing: 'field' } }, { cwd: __dirname });
  assert.equal(result, undefined);
});

// -- getArgumentCompletions returns family suggestions -----------------------

test('getArgumentCompletions filters PI_COMMAND_FAMILIES by prefix and returns null when empty', () => {
  const matches = _internals.getArgumentCompletions('mi');
  assert.ok(Array.isArray(matches) && matches.length > 0);
  assert.ok(matches.some((m) => m.value === 'milestone'));
  for (const m of matches) {
    assert.equal(typeof m.value, 'string');
    assert.equal(typeof m.label, 'string');
  }

  const all = _internals.getArgumentCompletions('');
  assert.ok(Array.isArray(all) && all.length > 0);
  assert.deepEqual(all.map((m) => m.value), [..._internals.PI_COMMAND_FAMILIES]);

  const none = _internals.getArgumentCompletions('zzz-no-such-family-8675309');
  assert.equal(none, null);
});

// -- fail-closed negotiation for pi -------------------------------------------

test('negotiateHostCapabilities never throws for pi, even on an undeclared/corrupted axis', () => {
  assert.doesNotThrow(() => negotiateHostCapabilities({}));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...PI_AXES, embeddingMode: UNDOCUMENTED }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...PI_AXES, embeddingMode: 'future-unknown-axis-value' }));
  assert.doesNotThrow(() => negotiateHostCapabilities({ ...PI_AXES, dispatch: undefined }));
});

test('pi axes negotiate modelMode:"active" (the active-model steering axis)', () => {
  const result = negotiateHostCapabilities(PI_AXES);
  assert.equal(result.effective.modelMode, 'active');
});
