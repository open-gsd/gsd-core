'use strict';

/**
 * pi upgrades — ADR-1239 Phase D / #2102 Stage 2 (EoS/pi).
 *
 * Mirrors tests/opencode-imperative-reference.test.cjs's structure (Host-
 * Integration axes classification/negotiation + the Context7-verified
 * upgrades) for pi's three additive upgrades:
 *   1. EXTENSION_EVENT_SURFACES.pi — the full ExtensionAPI event surface
 *      (was a single-event ['tool_call'] placeholder; 30 events in #2102, the
 *      41 pi 1.3.0 declares since #5557).
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
const { cleanup } = require('./helpers.cjs');

const {
  extensionEventSurfaceFor,
  negotiateHostCapabilities,
  UNDOCUMENTED,
} = require('../gsd-core/bin/lib/host-integration.cjs');

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

// -- (1) EXTENSION_EVENT_SURFACES.pi has all 41 pi 1.3.0 events (#5557) -------
//
// Source of truth: the `on(event: "...", ...)` overloads in pi 1.3.0's
// @earendil-works/pi-coding-agent dist/core/extensions/types.d.ts (the host's
// own declarations; pi.dev's extensions page lists a lossy subset). The 30
// events #2102 declared are a strict subset; the 11 below were added since.

const PI_130_ADDED_EVENTS = [
  'agent_before_settle', 'agent_settled', 'before_provider_headers',
  'cache_warming_decision', 'context_with_system', 'mcp_servers_change',
  'provider_stream_event', 'session_compact_failed', 'ui_prompt_end',
  'ui_prompt_start', 'user_bash',
];

const EXPECTED_PI_EVENTS = [
  'session_start', 'project_trust', 'resources_discover', 'input',
  'before_agent_start', 'agent_start', 'message_start', 'message_update',
  'message_end', 'turn_start', 'context', 'before_provider_request',
  'after_provider_response', 'tool_execution_start', 'tool_execution_update',
  'tool_execution_end', 'tool_call', 'tool_result', 'turn_end', 'agent_end',
  'session_before_switch', 'session_shutdown', 'session_before_fork',
  'session_info_changed', 'session_before_compact', 'session_compact',
  'session_before_tree', 'session_tree', 'thinking_level_select', 'model_select',
  ...PI_130_ADDED_EVENTS,
];

test('pi extension-event surface declares exactly the 41 pi 1.3.0 ExtensionAPI events (#5557)', () => {
  const surface = extensionEventSurfaceFor('pi');
  assert.ok(surface, 'pi is a consumed extensionEvents dialect');
  assert.equal(surface.length, 41, `expected exactly 41 events, got ${surface.length}`);
  assert.equal(new Set(surface).size, surface.length, 'no duplicate events');
  for (const ev of EXPECTED_PI_EVENTS) {
    assert.ok(surface.includes(ev), `expected pi extension-event surface to include "${ev}"`);
  }
  assert.deepEqual([...surface].sort(), [...EXPECTED_PI_EVENTS].sort());
});

test('every event gsdPiExtension binds is declared in the pi extension-event surface (#5557)', () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const surface = extensionEventSurfaceFor('pi');
  const bound = Object.keys(pi._recorded.events);
  assert.ok(bound.length > 0, 'extension binds at least one event');
  for (const ev of bound) {
    assert.ok(surface.includes(ev), `pi/gsd.cjs binds "${ev}", which is not in the declared pi surface`);
  }
});

test('pi descriptor declares a node runtime for the managed pi 1.3.0 install (#5557)', () => {
  assert.equal(PI_AXES.runtime, 'node');
  assert.ok(!/bun/i.test(PI_CAP.description), 'descriptor description must not claim a bun runtime');
  const negotiated = negotiateHostCapabilities(PI_AXES);
  assert.equal(negotiated.effective.runtime, 'node');
  assert.equal(negotiated.effective.dispatch.namedDispatch, false);
  // The generated registry is what the CLI reads; it must carry the same values
  // as the source descriptor (a stale registry once rendered nothing for pi).
  const registered = require('../gsd-core/bin/lib/capability-registry.cjs').runtimes.pi.runtime.hostIntegration;
  assert.equal(registered.runtime, 'node');
  assert.equal(registered.effortSurface, 'argv');
});

test('pi declares an argv effort surface and renders pi --thinking (pi 1.3.0 CLI, #5557)', () => {
  const { renderEffortArgv, clampEffortForHost } = require('../gsd-core/bin/lib/model-catalog.cjs');
  assert.equal(PI_AXES.effortSurface, 'argv');
  assert.equal(negotiateHostCapabilities(PI_AXES).effective.effortSurface, 'argv');
  assert.deepEqual(renderEffortArgv('pi', 'high', 'argv').argv, ['--thinking', 'high']);
  // pi accepts minimal natively, so unlike claude/codex it is not clamped up to low.
  assert.deepEqual(renderEffortArgv('pi', 'minimal', 'argv').argv, ['--thinking', 'minimal']);
  // `inherit` is never a wire level (#3533 10d); pi's own `off` has no universal counterpart.
  assert.deepEqual(renderEffortArgv('pi', 'inherit', 'argv').argv, []);
  assert.equal(clampEffortForHost('pi', 'off'), null);
  // The axis gate still wins over the table: a non-argv surface renders nothing.
  assert.deepEqual(renderEffortArgv('pi', 'high', 'none').argv, []);
  // Pin pi's own supported set: only the universal ladder reaches argv.
  for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(renderEffortArgv('pi', level, 'argv').argv, ['--thinking', level]);
  }
  // Hostile / out-of-set levels never reach argv (the level is argv-bound).
  for (const level of ['ultra', '', 'HIGH', 'high; rm -rf /', '--model', 'high --model x']) {
    assert.deepEqual(renderEffortArgv('pi', level, 'argv').argv, [], `level ${JSON.stringify(level)} must render nothing`);
  }
  // A hostile host id never resolves an inherited member of the table.
  assert.deepEqual(renderEffortArgv('__proto__', 'high', 'argv').argv, []);
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
//
// #2460: the bound handler now FAILS-OPENS when no explicit
// model_profile_overrides.pi[tier] is configured. pi is provider-agnostic;
// the built-in tier default (claude-sonnet-5) is an Anthropic-ecosystem
// assumption that broke every non-Anthropic provider. The test below
// asserts the fail-open contract for the no-override case.
test('the ACTUALLY-REGISTERED before_provider_request handler fail-opens when no model_profile_overrides is configured (#2460)', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const boundHandler = pi._recorded.events['before_provider_request'][0];
  assert.equal(typeof boundHandler, 'function');

  // __dirname has no .planning/config.json with model_profile_overrides, so
  // the handler must NOT steer — returns undefined so pi's chosen model flows
  // through untouched.
  const out = await boundHandler({ payload: { model: 'k3' } }, { cwd: __dirname });
  assert.equal(out, undefined, 'no override configured → must fail-open (return undefined), not steer to claude-sonnet-5');
});

// -- (3) before_provider_request: active-model steering ----------------------
//
// #2460: the handler ONLY steers when the user has explicitly opted in via
// model_profile_overrides. The fail-open path (no override) is the bug fix;
// the override path below documents the opt-in contract.

test('before_provider_request fail-opens when no model_profile_overrides is configured (#2460 bug discriminator)', async () => {
  const handler = _internals.buildBeforeProviderRequestHandler({ tier: 'sonnet' });
  // Reproduces the issue reporter\'s exact repro: user-selected model 'k3'
  // (or any non-Anthropic id) must NOT be rewritten to claude-sonnet-5.
  const result = await handler({ payload: { model: 'k3', messages: [{ role: 'user', content: 'hi' }] } }, { cwd: __dirname });
  assert.equal(result, undefined, 'no override configured → must NOT rewrite payload.model');
});

test('before_provider_request steers to the override model when model_profile_overrides.pi[tier] is explicitly configured', async () => {
  // Build a temp project with an explicit override and point the handler at it.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-steer-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ model_profile_overrides: { pi: { sonnet: 'kimi-coding/k3' } } }),
    );
    const handler = _internals.buildBeforeProviderRequestHandler({ tier: 'sonnet' });
    const result = await handler({ payload: { existing: 'field', model: 'will-be-overwritten' } }, { cwd: tmpDir });
    assert.ok(result, 'explicit override configured → expected a modified payload, not undefined');
    assert.equal(result.existing, 'field', 'original payload fields are preserved');
    assert.equal(result.model, 'kimi-coding/k3', 'model id matches the user-configured override');
  } finally {
    cleanup(tmpDir);
  }
});

test('before_provider_request fail-opens when override is explicitly null or empty (#2460)', async () => {
  // Defensive: an explicit null/empty override entry must NOT be treated as
  // "user opted in". The user might null/empty out a previously-set override.
  // Without the empty-string guard, resolveTierEntry's falsy `if (userRaw)`
  // would silently fall back to the built-in catalog and rewrite payload.model
  // to claude-sonnet-5 — re-introducing the bug this PR fixes.
  for (const emptyValue of [null, '']) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-empty-override-${emptyValue === null ? 'null' : 'empty'}-`));
    try {
      fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'config.json'),
        JSON.stringify({ model_profile_overrides: { pi: { sonnet: emptyValue } } }),
      );
      const handler = _internals.buildBeforeProviderRequestHandler({ tier: 'sonnet' });
      const result = await handler({ payload: { model: 'k3' } }, { cwd: tmpDir });
      assert.equal(result, undefined, `override === ${JSON.stringify(emptyValue)} → must fail-open (got ${JSON.stringify(result)})`);
    } finally {
      cleanup(tmpDir);
    }
  }
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

// -- native-extension auto-discovery contract (#2470) -------------------------
//
// pi auto-discovers extensions by scanning <agentDir>/extensions/ and keeping
// only names its `isExtensionFile()` predicate accepts:
//
//   function isExtensionFile(name) {
//     return name.endsWith(".ts") || name.endsWith(".js");
//   }
//
// (@earendil-works/pi-coding-agent, packages/coding-agent/src/core/extensions/
// loader.ts — verified upstream 2026-07-20.) A dest filename outside that set
// is skipped SILENTLY: no /gsd command, no error, no log line. pi loads the
// accepted file through jiti, which handles CommonJS and ESM alike, so the
// extension's module format is irrelevant to discovery — only the suffix is.
//
// These assertions deliberately encode pi's PREDICATE rather than the literal
// filename, so they keep protecting the contract if the extension is ever
// renamed again, and they state the reason the rename mattered.

/** pi's upstream discovery predicate, mirrored verbatim. */
function piIsExtensionFile(name) {
  return name.endsWith('.ts') || name.endsWith('.js');
}

test('pi capability declares a native-extension dest filename pi will auto-discover (#2470)', () => {
  const np = PI_CAP.runtime.hostBehaviors.nativePlugin;
  assert.ok(np && np.file, 'pi must declare hostBehaviors.nativePlugin.file');
  assert.ok(
    piIsExtensionFile(np.file),
    `pi's installed extension "${np.file}" must end in .ts or .js — pi's isExtensionFile() ` +
      'auto-discovery filter silently skips every other suffix, so /gsd never registers (#2470)',
  );
});

test('pi native-extension source stays CommonJS-explicit while the dest satisfies pi (#2470)', () => {
  const np = PI_CAP.runtime.hostBehaviors.nativePlugin;
  // The in-repo source keeps its .cjs suffix on purpose: tests require() it
  // directly and .cjs is unambiguous CommonJS regardless of any future
  // package.json "type" flip. Only the INSTALLED name must satisfy pi, and
  // jiti parses the copied file by content, not by suffix.
  assert.ok(
    np.source.endsWith('.cjs'),
    `pi's in-repo extension source should stay .cjs (explicit CommonJS), got "${np.source}"`,
  );
  assert.ok(
    fs.existsSync(path.join(__dirname, '..', np.source)),
    `pi's declared nativePlugin.source "${np.source}" must exist in the repo`,
  );
});
