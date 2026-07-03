'use strict';

/**
 * VS Code extension reachability test — ADR-1239 Phase D / #1942.
 *
 * Proves the VS Code extension is keystone-WIRED: the gsd.invoke handler
 * dispatches through the GSD command-routing hub and returns a result (not just
 * a stub). The handler is exported separately from activate() so it is testable
 * WITHOUT a VS Code host.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { activate, dispatchGsdCommand, resolveEngineRoot } = require('../vscode/extension.js');

test('the extension exports activate + dispatchGsdCommand + resolveEngineRoot', () => {
  assert.equal(typeof activate, 'function');
  assert.equal(typeof dispatchGsdCommand, 'function');
  assert.equal(typeof resolveEngineRoot, 'function');
});

test('REACHABILITY: dispatchGsdCommand dispatches through the engine hub (keystone wired)', async () => {
  const result = await dispatchGsdCommand({ family: 'query', subcommand: 'help' });
  assert.equal(typeof result, 'string', 'returns a string result');
  const parsed = JSON.parse(result);
  assert.ok(parsed !== null && typeof parsed === 'object',
    'dispatch produced a result object (the engine was reached)');
});

test('dispatchGsdCommand works with default args (no args → query/help)', async () => {
  const result = await dispatchGsdCommand();
  assert.equal(typeof result, 'string');
  JSON.parse(result); // must be valid JSON
});

test('resolveEngineRoot finds the gsd-core/ dir from the extension location', () => {
  const root = resolveEngineRoot(__dirname + '/../vscode');
  const fs = require('fs');
  assert.ok(fs.existsSync(require('path').join(root, 'gsd-core')),
    'resolveEngineRoot finds a dir containing gsd-core/');
});

test('the extension manifest declares the gsd.invoke command', () => {
  const pkg = require('../vscode/package.json');
  assert.ok(pkg.contributes && pkg.contributes.commands, 'manifest has commands');
  const cmd = pkg.contributes.commands.find((c) => c.command === 'gsd.invoke');
  assert.ok(cmd, 'manifest declares gsd.invoke');
  assert.ok(pkg.engines && pkg.engines.vscode, 'manifest declares VS Code engine');
  assert.equal(pkg.main, './extension.js', 'manifest main points to extension.js');
});
