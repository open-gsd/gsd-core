'use strict';

/**
 * GSD extension for pi (pi.dev) — ADR-1239 Phase D / #1944.
 *
 * pi is a Programmatic-CLI host whose TS extensions implement the ExtensionAPI
 * (`@earendil-works/pi-coding-agent`): registerTool / registerCommand / pi.on.
 * This extension binds GSD's command surface to pi via the imperative adapter
 * path — the programmatic-CLI peer of the OpenCode worked binding.
 *
 * Installation: copy this file to ~/.pi/agent/extensions/gsd.cjs (pi loads
 * extensions via jiti from that dir). The engine is resolved from the installed
 * GSD tree (walk-up like the OpenCode plugin).
 *
 * Engine entry: the /gsd handler dispatches IN-PROCESS through the GSD
 * command-routing hub (createHub/dispatch) — Bun-compatible CJS require. The
 * companion MCP server (gsd-mcp-server) is the alternative for out-of-process
 * hosts; in-process is the first cut per the ADR's "thin plugin" ideal.
 *
 * @param {object} pi  pi ExtensionAPI (registerTool/registerCommand/on/…)
 */
module.exports = function gsdPiExtension(pi) {
  if (!pi || typeof pi !== 'object') {
    throw new TypeError('gsdPiExtension: pi ExtensionAPI is required');
  }

  // Resolve the GSD engine tree (the dir holding gsd-core/ + hooks/).
  // Works across dev (<root>/pi/gsd.cjs → <root>) and installed layouts.
  const fs = require('fs');
  const path = require('path');
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

  // ── /gsd command: dispatch through the GSD command-routing hub ──────────
  pi.registerCommand('gsd', {
    description: 'Invoke a GSD command via the embedded engine (imperative adapter).',
    execute: async function (ctx) {
      const { createHub } = require(path.join(GSD_CORE, 'bin', 'lib', 'command-routing-hub.cjs'));
      const hub = createHub();
      const res = hub.dispatch({
        family: (ctx && ctx.family) || 'query',
        subcommand: (ctx && ctx.subcommand) || 'help',
        args: (ctx && Array.isArray(ctx.args)) ? ctx.args : [],
        cwd: (ctx && ctx.cwd) || process.cwd(),
      });
      return JSON.stringify(res);
    },
  });

  // ── gsd_invoke tool: programmatic command invocation ────────────────────
  pi.registerTool({
    name: 'gsd_invoke',
    description: 'Invoke a GSD command family/subcommand through the engine.',
    execute: async function () {
      const { createHub } = require(path.join(GSD_CORE, 'bin', 'lib', 'command-routing-hub.cjs'));
      const hub = createHub();
      const res = hub.dispatch({ family: 'query', subcommand: 'help', args: [], cwd: process.cwd() });
      return JSON.stringify(res);
    },
  });

  // ── tool_call event: lifecycle hook bridge (extensionEvents: pi) ────────
  pi.on('tool_call', async function () {
    /* GSD hook bridge attachment point (PreToolUse/PostToolUse mapping). */
  });
};

// Test-only internals (mirrors the OpenCode plugin pattern).
module.exports._internals = { resolveEngineRoot: null };
