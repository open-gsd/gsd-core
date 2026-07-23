'use strict';

/**
 * pi imperative reference host — ADR-1239 Phase D / #1682 Slice 3.
 *
 * Proves the Programmatic-CLI reference binding for pi via the ExtensionAPI
 * imperative adapter (#1682 AC: "invoke gsd tools/commands in pi via the
 * ExtensionAPI imperative adapter"):
 *   1. createImperativeAdapter({runtime:'pi'}) classifies as imperative + composes the registry.
 *   2. pi's axes (imperative + bun) classify as 'programmatic-cli' (the reference profile).
 *   3. the reference pi host-plugin binds GSD via ExtensionAPI (registers command + tool + event).
 *
 * Full `--pi` installable-runtime integration shipped in #2102 Stage 1
 * (capabilities/pi/capability.json + bin/install.js wiring + golden parity
 * 16→17, see tests/fixtures/golden-install-parity/pi.json); this slice
 * continues to prove the imperative ExtensionAPI binding in isolation.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
const { profileOf } = require('../gsd-core/bin/lib/host-integration.cjs');
const gsdPiPlugin = require('./fixtures/pi-host-plugin.cjs');

// Mock pi ExtensionAPI: records registrations so the plugin is testable without
// a live pi runtime. Records the full command/tool definitions (not just
// names) so #2102's handler/execute SHAPE can be asserted, not just presence.
function mockPi() {
  const recorded = { commands: [], tools: [], events: [], commandDefs: {}, toolDefs: {} };
  return {
    registerCommand(name, def) { recorded.commands.push(name); recorded.commandDefs[name] = def; },
    registerTool(def) { if (def && def.name) { recorded.tools.push(def.name); recorded.toolDefs[def.name] = def; } },
    registerShortcut() {},
    registerFlag() {},
    on(event) { recorded.events.push(event); },
    _recorded: recorded,
  };
}

test('createImperativeAdapter classifies pi as an imperative host + composes the registry', () => {
  const adapter = createImperativeAdapter({ runtime: 'pi' });
  assert.equal(adapter.kind, 'imperative');
  assert.equal(adapter.runtime, 'pi');
  assert.ok(adapter.registry, 'imperative adapter exposes the composed capability registry');
  assert.equal(typeof adapter.install, 'function');
  assert.equal(typeof adapter.uninstall, 'function');
});

test('pi axes classify as the programmatic-cli reference profile', () => {
  // pi: imperative embedding, bun runtime (NOT sandboxed-web) → programmatic-cli.
  assert.equal(profileOf({ embeddingMode: 'imperative', runtime: 'bun' }), 'programmatic-cli');
  assert.notEqual(profileOf({ embeddingMode: 'imperative', runtime: 'bun' }), 'ide');
});

test('the pi reference host-plugin binds GSD via the ExtensionAPI (command + tool + event)', () => {
  const pi = mockPi();
  gsdPiPlugin(pi);
  assert.ok(pi._recorded.commands.includes('gsd'), 'registers the /gsd command');
  assert.ok(pi._recorded.tools.includes('gsd_invoke'), 'registers the gsd_invoke tool');
  assert.ok(pi._recorded.events.includes('tool_call'), 'subscribes to the tool_call event');
});

// #2102 Stage 2: pi's REAL ExtensionAPI shape is `handler(args, ctx)` for
// registerCommand (NOT `execute(ctx)`, which the original #1682 cut used) and
// a 5-arg `execute(toolCallId, params, signal, onUpdate, ctx)` for
// registerTool. Locks the shape so a future drift back to the wrong contract
// is a visible test failure.
test('the /gsd command registers a handler(args, ctx) — not execute(ctx)', () => {
  const pi = mockPi();
  gsdPiPlugin(pi);
  const def = pi._recorded.commandDefs['gsd'];
  assert.equal(typeof def.handler, 'function', 'registerCommand takes handler(args, ctx), pi\'s real ExtensionAPI shape');
  assert.equal(def.execute, undefined, 'must not use the wrong execute(ctx) shape');
});

test('the gsd_invoke tool registers a 5-arg execute(toolCallId, params, signal, onUpdate, ctx)', () => {
  const pi = mockPi();
  gsdPiPlugin(pi);
  const def = pi._recorded.toolDefs['gsd_invoke'];
  assert.equal(typeof def.execute, 'function');
  assert.equal(def.execute.length, 5, 'gsd_invoke.execute must declare pi\'s real 5-arg tool-execute signature');
});

test('gsdPiPlugin throws if the pi ExtensionAPI is not provided (fail-closed)', () => {
  assert.throws(() => gsdPiPlugin(null), /ExtensionAPI is required/);
  assert.throws(() => gsdPiPlugin(undefined), /ExtensionAPI is required/);
});
