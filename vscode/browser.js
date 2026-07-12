'use strict';

/**
 * GSD extension for VS Code — WEB (browser) entry, #2103.
 *
 * This is the `browser` entry point (vscode/package.json `"browser": "./browser.js"`),
 * loaded by VS Code Web / vscode.dev in a webworker context. It has ZERO Node
 * APIs: no `require('fs')`, `require('path')`, or `require('child_process')`,
 * and no Node globals (`process`, `Buffer`, `__dirname`, `__filename`). This is
 * a HARD constraint, not a style preference — a Web Extension host does not
 * have Node's core modules available at all; requiring one throws immediately
 * at load time and breaks activation.
 *
 * WHY THIS FILE DOES NOT REQUIRE `./host-binding.js` OR `./extension.js`
 * (a deliberate deviation from "compose the seams via bindGsdToVscode" — see
 * the #2103 dispatch-crux note below):
 *
 * `host-binding.js`'s `bindGsdToVscode` is NOT actually web-safe once its
 * transitive dependencies are checked — three of its four required engine-lib
 * modules pull in Node's `fs`/`os`/`path` at module-load time (eagerly, on
 * every `require()`, regardless of which code path runs):
 *   - gsd-core/bin/lib/state-io.cjs           → requires 'node:fs' directly.
 *   - gsd-core/bin/lib/adapter-imperative.cjs → requires install-engine.cjs +
 *                                                capability-loader.cjs (fs/os/path).
 *   - gsd-core/bin/lib/model-adapter.cjs      → requires model-resolver.cjs →
 *                                                config-loader.cjs (fs/os/path) +
 *                                                configuration.cjs (fs/path).
 * (gsd-core/bin/lib/hook-bus.cjs alone has no requires and is genuinely
 * web-safe.) Requiring `host-binding.js` here would transitively pull in
 * `node:fs` and throw at web-worker load time — the opposite of "zero Node
 * APIs". See host-binding.js's own header comment for the full chain. Fixing
 * those engine-lib modules to be fs-free is a separate, much larger
 * engine-wide refactor (config/capability loading genuinely reads files from
 * disk for every OTHER host) — out of scope here; flagged rather than routed
 * around silently.
 *
 * So this file implements its OWN minimal, independently-verified-zero-Node-API
 * composition directly against `vscode.lm` — no engine-lib requires at all.
 *
 * DISPATCH STORY ON WEB (per the #2103 dispatch-crux design): full GSD engine
 * dispatch (the gsd-tools.cjs subprocess-shim `dispatchGsdCommand` used by the
 * desktop `extension.js`) is fundamentally a Node `child_process.spawnSync`
 * call — there is no web-worker equivalent. On web, GSD command dispatch is
 * available through VS Code's NATIVE MCP client connecting to the GSD
 * companion MCP server (gsd-core/bin/lib/mcp-server.cjs, `gsd-mcp-server`
 * bin entry — a separate, already-existing surface; this file does NOT
 * implement an MCP client itself, it only points the user at that story).
 * The chat participant and Language Model Tools registered below are
 * therefore intentionally limited on web: they register (so the surface is
 * discoverable and `#runSubagent`-eligible per VS Code's chat engine) but
 * their handlers return an honest "configure the GSD MCP server for full
 * dispatch on web" message rather than silently failing or faking success.
 */

/**
 * Tokenizes a raw chat/free-form prompt string. Kept local (not shared with
 * extension.js) so this file has zero requires of any kind beyond `vscode`.
 * @param {string} rawPrompt
 * @returns {{family: string, subcommand: string|undefined, args: string[]}}
 */
function parseChatPrompt(rawPrompt) {
  const tokens = String(rawPrompt || '').trim().split(/\s+/).filter(Boolean);
  return {
    family: tokens[0] || '--help',
    subcommand: tokens[1],
    args: tokens.slice(2),
  };
}

/**
 * The honest "web mode" message every web-surface handler returns instead of
 * attempting Node-only engine dispatch.
 * @param {string} family
 */
function webDispatchUnavailableMessage(family) {
  return (
    `GSD web mode: full engine dispatch for "${family}" is not available in the browser ` +
    '(the VS Code Web/webworker host has no Node runtime, so the gsd-tools.cjs ' +
    'subprocess dispatch used on desktop cannot run here). Configure the GSD MCP ' +
    'server (gsd-mcp-server) as a VS Code MCP server for full command dispatch on web, ' +
    'or use the desktop GSD Core extension.'
  );
}

/**
 * Registers the `@gsd` chat participant in web mode (#2103). Its handler is
 * honest about the web dispatch limitation — see webDispatchUnavailableMessage.
 * Exported separately so it is testable with a mock `vscode.chat`.
 * @param {object} vscode
 * @param {import('vscode').ExtensionContext} context
 * @returns {object|null} the created participant, or null if vscode.chat is absent.
 */
function registerChatParticipant(vscode, context) {
  if (!vscode || !vscode.chat || typeof vscode.chat.createChatParticipant !== 'function') {
    return null;
  }
  const participant = vscode.chat.createChatParticipant('gsd', async (request, _chatContext, stream, _token) => {
    const { family } = parseChatPrompt(request && request.prompt);
    if (stream && typeof stream.markdown === 'function') {
      stream.markdown(webDispatchUnavailableMessage(family));
    }
    return { metadata: { command: family, mode: 'web' } };
  });
  if (context && Array.isArray(context.subscriptions)) context.subscriptions.push(participant);
  return participant;
}

/**
 * The same representative LM tool NAMES as the desktop extension (must match
 * package.json's contributes.languageModelTools[].name — underscored, the
 * vscode.lm.registerTool registration name — so the manifest is identical
 * across both entry points), but with web-mode invoke() handlers.
 */
const LM_TOOL_NAMES = ['gsd_progress', 'gsd_workstreams', 'gsd_plan_phase'];

/**
 * Registers web-mode LM tools via vscode.lm.registerTool (#2103). Each
 * invoke() returns the honest web-dispatch-unavailable message — no engine-lib
 * requires, no Node APIs.
 * @param {object} vscode
 * @param {import('vscode').ExtensionContext} context
 * @returns {number} count of tools registered (0 if vscode.lm is absent — fail-soft).
 */
function registerLanguageModelTools(vscode, context) {
  if (!vscode || !vscode.lm || typeof vscode.lm.registerTool !== 'function') return 0;
  let count = 0;
  for (const name of LM_TOOL_NAMES) {
    const impl = {
      async invoke(_options, _token) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(webDispatchUnavailableMessage(name)),
        ]);
      },
    };
    const disposable = vscode.lm.registerTool(name, impl);
    if (context && Array.isArray(context.subscriptions)) context.subscriptions.push(disposable);
    count++;
  }
  return count;
}

/**
 * Detects `#runSubagent` feature availability (`chat.subagents.allowInvocationsFromSubagents`,
 * VS Code 1.105+). Fail-soft: never throws. Identical detection logic to the
 * desktop extension.js (duplicated, not shared, to keep this file at zero
 * requires) — see extension.js's registerSubagentDispatch for the rationale
 * that VS Code's chat engine itself surfaces registered participants/tools to
 * `#runSubagent`, with no separate registration API.
 * @param {object} vscode
 * @returns {{available: boolean}}
 */
function detectSubagentSupport(vscode) {
  let available = false;
  try {
    const cfg = vscode && vscode.workspace && typeof vscode.workspace.getConfiguration === 'function'
      ? vscode.workspace.getConfiguration('chat.subagents')
      : null;
    available = !!(cfg && typeof cfg.get === 'function' && cfg.get('allowInvocationsFromSubagents') !== undefined);
  } catch {
    available = false;
  }
  return { available };
}

/**
 * VS Code Web extension activation. Registers the chat participant + Language
 * Model Tools in web mode. Does NOT register the `gsd.invoke` command with a
 * real-dispatch handler (there is no Node dispatch on web) — the command is
 * still contributed (contributes.commands in package.json is shared across
 * desktop/web), so it is registered here too, but its handler returns the
 * same honest web-mode message.
 * @param {import('vscode').ExtensionContext} context
 */
function activate(context) {
  const vscode = require('vscode');

  const gsdCommand = vscode.commands.registerCommand('gsd.invoke', async (args) => {
    const a = (args && typeof args === 'object') ? args : {};
    const family = (typeof a.family === 'string' && a.family) ? a.family : '--help';
    return JSON.stringify({ ok: false, stdout: '', stderr: webDispatchUnavailableMessage(family), code: null, timedOut: false });
  });
  context.subscriptions.push(gsdCommand);

  registerChatParticipant(vscode, context);
  registerLanguageModelTools(vscode, context);
  detectSubagentSupport(vscode);
}

module.exports = {
  activate,
  parseChatPrompt,
  webDispatchUnavailableMessage,
  registerChatParticipant,
  registerLanguageModelTools,
  detectSubagentSupport,
  LM_TOOL_NAMES,
};
