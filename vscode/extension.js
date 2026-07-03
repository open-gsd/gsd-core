'use strict';

/**
 * GSD extension for VS Code — ADR-1239 Phase D / #1942.
 *
 * VS Code is the IDE-profile reference host. This extension binds GSD's command
 * surface to VS Code's Command Palette + Chat participant via the imperative
 * adapter path. Engine entry: in-process CJS require (the extension host runs
 * Node). The engine seams (active model via vscode.lm, engine-owned hook bus,
 * sandboxed-storage stateIO) are composed in activate() per the #1933 binding.
 *
 * Installation: repo-local (not Marketplace-published). Open this dir in VS Code
 * + press F5 (Extension Development Host) to run, or package with `vsce package`.
 *
 * Engine entry: the gsd.invoke handler dispatches IN-PROCESS through the GSD
 * command-routing hub (createHub/dispatch). This is the same hub the companion
 * MCP server + the pi extension use.
 */

const path = require('path');
const fs = require('fs');

// Resolve the GSD engine tree (walk up to find gsd-core/).
function resolveEngineRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'gsd-core'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, '..');
}

const ENGINE_ROOT = resolveEngineRoot(__dirname);
const GSD_CORE = path.join(ENGINE_ROOT, 'gsd-core');

/**
 * Pure command handler — dispatches through the GSD command-routing hub.
 * Exported separately from activate() so it is testable WITHOUT a VS Code host.
 * @returns {Promise<string>} JSON-stringified dispatch result.
 */
async function dispatchGsdCommand(args) {
  const { createHub } = require(path.join(GSD_CORE, 'bin', 'lib', 'command-routing-hub.cjs'));
  const hub = createHub();
  const res = hub.dispatch({
    family: (args && args.family) || 'query',
    subcommand: (args && args.subcommand) || 'help',
    args: (args && Array.isArray(args.args)) ? args.args : [],
    cwd: (args && args.cwd) || process.cwd(),
  });
  return JSON.stringify(res);
}

/**
 * VS Code extension activation. Composes the IDE-profile seams (per the #1933
 * reference binding) + registers the command surface.
 * @param {import('vscode').ExtensionContext} context
 */
function activate(context) {
  const vscode = require('vscode');

  // ── Command surface: palette + chat participant ──────────────────────────
  const gsdCommand = vscode.commands.registerCommand('gsd.invoke', dispatchGsdCommand);
  context.subscriptions.push(gsdCommand);

  // The full IDE-profile binding (active vscode.lm model, engine-owned hook bus,
  // sandboxed-storage stateIO, imperative adapter) composes in activate() per
  // the #1933 reference binding (tests/fixtures/vscode-host-binding.cjs). The
  // command handler dispatches through the hub — the user-reachable surface.
}

module.exports = { activate, dispatchGsdCommand, resolveEngineRoot };
