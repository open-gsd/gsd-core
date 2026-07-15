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
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

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

function mockZod() {
  const schema = () => ({ default: () => schema(), optional: () => schema() });
  return { object: () => schema(), string: schema, array: () => schema(), boolean: schema };
}

function mockPi() {
  const recorded = { commands: {}, tools: {}, events: {} };
  return {
    zod: mockZod(),
    registerCommand(name, def) { recorded.commands[name] = def; },
    registerTool(def) { if (def && def.name) recorded.tools[def.name] = def; },
    registerProvider() {
      throw new Error('gsdPiExtension must NOT call registerProvider — GSD steers pi\'s existing anthropic models, it does not add a new provider');
    },
    on(event, handler) { (recorded.events[event] = recorded.events[event] || []).push(handler); },
    _recorded: recorded,
  };
}

// -- (1) EXTENSION_EVENT_SURFACES.pi matches OMP's typed event API ----------

const EXPECTED_PI_EVENTS = [
  'resources_discover', 'session_start',
  'session_before_switch', 'session_switch',
  'session_before_branch', 'session_branch',
  'session_before_compact', 'session.compacting', 'session_compact',
  'session_shutdown', 'session_before_tree', 'session_tree',
  'context', 'before_provider_request', 'after_provider_response',
  'before_agent_start', 'agent_start', 'agent_end', 'session_stop',
  'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
  'auto_compaction_start', 'auto_compaction_end',
  'auto_retry_start', 'auto_retry_end', 'ttsr_triggered', 'todo_reminder',
  'goal_updated', 'credential_disabled', 'input',
  'tool_approval_requested', 'tool_approval_resolved',
  'tool_call', 'tool_result', 'user_bash', 'user_python',
];

test('pi extension-event surface declares the full documented OMP ExtensionAPI', () => {
  const surface = extensionEventSurfaceFor('pi');
  assert.ok(surface, 'pi is a consumed extensionEvents dialect');
  assert.equal(surface.length, EXPECTED_PI_EVENTS.length, `expected exactly ${EXPECTED_PI_EVENTS.length} events, got ${surface.length}`);
  for (const ev of EXPECTED_PI_EVENTS) {
    assert.ok(surface.includes(ev), `expected pi extension-event surface to include "${ev}"`);
  }
  assert.deepEqual([...surface].sort(), [...EXPECTED_PI_EVENTS].sort());
});

// -- (2) the binding actually binds session_start/before_agent_start/ -------
//        session_before_compact (not just declared in host-integration.cts)

test('gsdPiExtension binds the native session, tool, and model-routing events', () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  for (const ev of ['session_start', 'tool_call', 'tool_result', 'turn_end', 'before_provider_request']) {
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
test('the ACTUALLY-REGISTERED before_provider_request handler is GSD-project scoped', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const boundHandler = pi._recorded.events['before_provider_request'][0];
  assert.equal(typeof boundHandler, 'function');
  assert.equal(await boundHandler({ payload: {} }, { cwd: os.tmpdir() }), undefined);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pi-model-route-'));
  try {
    fs.mkdirSync(path.join(cwd, '.planning'));
    fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), '---\nstatus: planning\n---\n');
    const out = await boundHandler({ payload: {} }, { cwd });
    assert.ok(out, 'expected a modified payload in a GSD project');
    assert.equal(out.model, RUNTIME_PROFILE_MAP.pi.sonnet.model);
    assert.equal(out.model, 'claude-sonnet-5');
  } finally {
    cleanup(cwd);
  }
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

test('before_provider_request leaves malformed payloads untouched', async () => {
  const handler = _internals.buildBeforeProviderRequestHandler({ tier: 'sonnet' });
  for (const payload of [undefined, null, 'not-a-request', 42, []]) {
    const result = await handler({ payload }, { cwd: __dirname });
    assert.equal(result, undefined, `payload ${String(payload)} must fail open`);
  }
});

test('runHook resolves fail-open when its terminated child never emits close or error', async () => {
  const child = new EventEmitter();
  const signals = [];
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.kill = (signal) => { signals.push(signal); return true; };

  let deadline;
  const result = await Promise.race([
    _internals.runHook('gsd-context-monitor.js', {}, { timeout: 1, spawnChild: () => child }),
    new Promise((resolve) => { deadline = setTimeout(() => resolve(null), 500); }),
  ]);
  clearTimeout(deadline);

  assert.notEqual(result, null, 'the timeout fallback must settle without a child close/error event');
  assert.equal(result.timedOut, true);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
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

test('Pi command completions cover every command advertised by gsd-tools', () => {
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs'), '--help'], { encoding: 'utf8' });
  const usage = `${cli.stdout || ''}${cli.stderr || ''}`;
  const commandList = usage.match(/Commands: ([\s\S]+?)\n\nGlobal flags:/);
  assert.ok(commandList, 'gsd-tools help must expose its command catalog');
  const canonical = commandList[1].replace(/\s+/g, ' ').split(', ').map((command) => command.trim()).filter(Boolean);
  assert.deepEqual([..._internals.PI_COMMAND_FAMILIES].sort(), canonical.sort());
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
