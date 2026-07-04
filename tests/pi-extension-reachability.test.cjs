'use strict';

/**
 * pi extension reachability test — ADR-1239 Phase D / #1944.
 *
 * Proves the pi extension is keystone-WIRED: the registered /gsd command
 * handler dispatches through the GSD command-routing hub and returns a result
 * (not just a registration on a mock). This is the "user can invoke X" proof.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const gsdPiExtension = require('../pi/gsd.cjs');

function mockPi() {
  const recorded = { commands: {}, tools: {}, events: [] };
  return {
    registerCommand(name, def) { recorded.commands[name] = def; },
    registerTool(def) { if (def && def.name) recorded.tools[def.name] = def; },
    on(event) { recorded.events.push(event); },
    _recorded: recorded,
  };
}

test('the pi extension registers /gsd + gsd_invoke + tool_call via ExtensionAPI', () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  assert.ok(pi._recorded.commands['gsd'], 'registers /gsd command');
  assert.ok(pi._recorded.tools['gsd_invoke'], 'registers gsd_invoke tool');
  assert.ok(pi._recorded.events.includes('tool_call'), 'subscribes to tool_call');
});

test('REACHABILITY: the /gsd handler dispatches through the engine hub (keystone wired)', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  // Invoke the registered /gsd handler — it must dispatch through createHub
  // and return a JSON result (not throw). This is the keystone-wired proof.
  const result = await pi._recorded.commands['gsd'].execute({
    family: 'query',
    subcommand: 'help',
  });
  assert.equal(typeof result, 'string', '/gsd handler returns a string result');
  const parsed = JSON.parse(result);
  assert.ok(parsed !== null && typeof parsed === 'object',
    '/gsd dispatch produced a result object (the engine was reached)');
});

test('REACHABILITY: the gsd_invoke tool dispatches through the engine hub', async () => {
  const pi = mockPi();
  gsdPiExtension(pi);
  const result = await pi._recorded.tools['gsd_invoke'].execute();
  assert.equal(typeof result, 'string');
  JSON.parse(result); // must be valid JSON (engine was reached)
});

test('gsdPiExtension throws without pi ExtensionAPI (fail-closed)', () => {
  assert.throws(() => gsdPiExtension(null), /ExtensionAPI is required/);
});
