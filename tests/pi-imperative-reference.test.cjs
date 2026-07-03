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
 * pi is an alias for the canonical omp installable runtime; this fixture
 * covers the legacy pi ExtensionAPI binding.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
const { profileOf } = require('../gsd-core/bin/lib/host-integration.cjs');
const gsdPiPlugin = require('./fixtures/pi-host-plugin.cjs');

// Mock pi ExtensionAPI: records registrations so the plugin is testable without
// a live pi runtime.
function mockPi() {
  const recorded = { commands: [], tools: [], events: [] };
  return {
    registerCommand(name) { recorded.commands.push(name); },
    registerTool(def) { if (def && def.name) recorded.tools.push(def.name); },
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

test('gsdPiPlugin throws if the pi ExtensionAPI is not provided (fail-closed)', () => {
  assert.throws(() => gsdPiPlugin(null), /ExtensionAPI is required/);
  assert.throws(() => gsdPiPlugin(undefined), /ExtensionAPI is required/);
});
