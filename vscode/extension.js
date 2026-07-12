'use strict';

/**
 * GSD extension for VS Code — ADR-1239 Phase D / #1942, dispatch fixed +
 * extension surface (chat participant, Language Model Tools, #runSubagent
 * wiring) added #2103.
 *
 * This is the DESKTOP (Node) `main` entry — see browser.js for the Web
 * Extension `browser` entry, which is intentionally a SEPARATE, much more
 * minimal file (zero Node APIs; does not require this file or host-binding.js).
 *
 * VS Code is the IDE-profile reference host. This extension binds GSD's command
 * surface to VS Code's Command Palette + Chat participant via the imperative
 * adapter path. Engine entry: in-process CJS require (the extension host runs
 * Node). The engine seams (active model via vscode.lm, engine-owned hook bus,
 * sandboxed-storage stateIO) are composed in activate() via host-binding.js
 * per the #1933 binding.
 *
 * Installation: Marketplace/VSIX extension (see capabilities/vscode/capability.json
 * — installSurface:'none', it is never CLI-installed by bin/install.js).
 *
 * Engine entry: dispatch is SUBPROCESS-REUSE to gsd-tools.cjs (bounded,
 * no-throw — the shared `dispatchGsdCommand` in
 * gsd-core/bin/lib/shell-command-projection.cjs), NOT an in-process
 * command-routing hub. No fully-populated hub factory exists anywhere in
 * gsd-core — every createHub() caller builds a single-family hub for its own
 * narrow purpose — so calling createHub() with no args (the original #1942
 * cut) always answered UnknownCommand. This mirrors the fix already applied
 * to the pi extension (pi/gsd.cjs) and the companion MCP server
 * (gsd-core/bin/lib/mcp-server.cjs), which dispatch through the SAME shared
 * helper (#2102 Stage 2 / #2103).
 *
 * Extension surface (#2103):
 *   - Chat participant `@gsd` (contributes.chatParticipants) — dispatches free-form
 *     prompts through the same dispatchGsdCommand.
 *   - Language Model Tools (contributes.languageModelTools) — a representative
 *     set of GSD skills exposed as vscode.lm tools, each dispatching through the
 *     same shared helper (UPGRADE 1).
 *   - #runSubagent wiring — VS Code 1.105+ lets the primary chat agent invoke
 *     registered chat participants / languageModelTools as a nested agent turn
 *     via `#runSubagent`, gated by the `chat.subagents.allowInvocationsFromSubagents`
 *     setting. There is no separate "subagent contribution" registration API
 *     beyond the participant + tools already registered above — VS Code's own
 *     chat engine surfaces them. This extension's own contribution is a
 *     belt-and-suspenders depth cap (dispatchAsSubagent, GSD_MAX_SUBAGENT_DEPTH)
 *     mirroring capabilities/vscode/capability.json's
 *     hostIntegration.dispatch.maxDepth:5, independent of whatever VS Code
 *     itself enforces natively (UPGRADE 2).
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
 * Pure command handler — dispatches through the SHARED subprocess-shim
 * `dispatchGsdCommand` (gsd-core/bin/lib/shell-command-projection.cjs), the
 * same helper the pi extension (pi/gsd.cjs) and the companion MCP server
 * (gsd-core/bin/lib/mcp-server.cjs) dispatch through.
 *
 * Exported separately from activate() so it is testable WITHOUT a VS Code
 * host. Preserves the original return CONTRACT — a JSON-stringified result
 * object — but now backed by a REAL dispatch instead of an unconfigured
 * `createHub()` that always answered UnknownCommand (#2103 fix).
 *
 * Empty/omitted args default to `--help` (a real, working, ok:true
 * gsd-tools.cjs command) — NOT the `'query'`/`'help'` pairing the original
 * cut used, which is not a valid gsd-tools.cjs command and always produced
 * UnknownCommand (mirrors the same fix already applied to
 * pi/gsd.cjs's parseGsdCommandArgs).
 *
 * @returns {Promise<string>} JSON-stringified dispatch result:
 *   `{ok, stdout, stderr, code, timedOut}` on a normal dispatch, or
 *   `{ok:false, stdout:'', stderr:'GSD engine unavailable: ...', code:null,
 *   timedOut:false}` if the shared helper itself cannot be loaded (e.g.
 *   gsd-core/ missing from the tree).
 */
async function dispatchGsdCommand(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const family = (typeof a.family === 'string' && a.family) ? a.family : '--help';
  const subcommand = (typeof a.subcommand === 'string' && a.subcommand) ? a.subcommand : undefined;
  const rest = Array.isArray(a.args) ? a.args : [];
  const cwd = a.cwd || process.cwd();

  let dispatchViaShim;
  try {
    ({ dispatchGsdCommand: dispatchViaShim } = require(path.join(GSD_CORE, 'bin', 'lib', 'shell-command-projection.cjs')));
  } catch (e) {
    return JSON.stringify({
      ok: false,
      stdout: '',
      stderr: `GSD engine unavailable: ${e && e.message ? e.message : String(e)}`,
      code: null,
      timedOut: false,
    });
  }
  const result = dispatchViaShim({ family, subcommand, args: rest, cwd });
  return JSON.stringify(result);
}

/**
 * Resolves the current workspace's root directory, per-invocation (never
 * cached at activate() time), so GSD commands dispatch against the user's
 * actual project instead of the extension host's own `process.cwd()` (#2103
 * FIX — adversarial review: all three desktop dispatch surfaces previously
 * omitted `cwd` entirely when calling dispatchGsdCommand, silently defaulting
 * to the wrong directory). Falls back to `process.cwd()` only when no
 * workspace folder is open (e.g. an empty window) — mirrors VS Code's own
 * single-root convention of reading `workspaceFolders[0]`.
 * @param {object} vscode
 * @returns {string}
 */
function resolveWorkspaceCwd(vscode) {
  const folders = vscode && vscode.workspace && vscode.workspace.workspaceFolders;
  const first = Array.isArray(folders) ? folders[0] : undefined;
  const fsPath = first && first.uri && first.uri.fsPath;
  return (typeof fsPath === 'string' && fsPath) ? fsPath : process.cwd();
}

/**
 * Tokenizes a raw chat/free-form prompt string into {family, subcommand, args}.
 * Mirrors pi/gsd.cjs's parseGsdCommandArgs (simple whitespace split — no shell
 * quoting support needed for a chat prompt). Empty input defaults to `--help`
 * (a real, working gsd-tools.cjs command), matching dispatchGsdCommand's own
 * default so the two surfaces (palette vs. chat) never diverge on "no input".
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
 * Registers the `@gsd` chat participant (#2103). Its handler dispatches the
 * user's free-form prompt through the SAME dispatchGsdCommand as gsd.invoke —
 * one dispatch path for every command surface (palette / chat / LM tools).
 * Exported separately so it is testable with a mock `vscode.chat`.
 * @param {object} vscode
 * @param {import('vscode').ExtensionContext} context
 * @returns {object|null} the created participant, or null if vscode.chat is absent
 *   (older VS Code — fail-soft, never throws).
 */
function registerChatParticipant(vscode, context) {
  if (!vscode || !vscode.chat || typeof vscode.chat.createChatParticipant !== 'function') {
    return null;
  }
  const participant = vscode.chat.createChatParticipant('gsd', async (request, _chatContext, stream, _token) => {
    // #2103 FIX: resolve the user's actual workspace, not the extension host's
    // process.cwd() — computed per-invocation so it always reflects the
    // CURRENT workspace (a chat request has no cwd field of its own; VS Code's
    // ChatContext does not carry one).
    const cwd = resolveWorkspaceCwd(vscode);
    const { family, subcommand, args } = parseChatPrompt(request && request.prompt);
    const result = JSON.parse(await dispatchGsdCommand({ family, subcommand, args, cwd }));
    if (stream && typeof stream.markdown === 'function') {
      stream.markdown(result.ok ? result.stdout : `GSD error: ${result.stderr || result.stdout || 'dispatch failed'}`);
    }
    return { metadata: { command: family } };
  });
  if (context && Array.isArray(context.subscriptions)) context.subscriptions.push(participant);
  return participant;
}

/**
 * #2103 UPGRADE 1 — Language Model Tools.
 *
 * A representative set of GSD skills (see skills/gsd-progress, skills/gsd-workstreams,
 * skills/gsd-plan-phase) exposed as vscode.lm tools, matching the
 * contributes.languageModelTools manifest entries in package.json. Each tool's
 * invoke() dispatches through the SAME shared dispatchGsdCommand as gsd.invoke —
 * the tool name maps to a real, verified family/subcommand pair (verified by
 * direct `gsd-tools.cjs <family> [subcommand] --raw --json-errors` invocation;
 * see the #2103 CORE-stage precedent for `progress json`).
 *
 * Kept to a small, curated set rather than all 71 shipped skills: these three
 * both name a real skill AND map cleanly onto a single, safe, read-only
 * gsd-tools.cjs command (the rest are multi-step agent workflows that do not
 * reduce to one non-interactive CLI call, and stay slash-command-native).
 */
// `name` uses underscores (vscode.lm.registerTool's registration name — MUST
// match contributes.languageModelTools[].name in package.json exactly); the
// hyphenated `#gsd-progress`-style mention alias is package.json's separate
// `toolReferenceName` field (VS Code owns that mapping internally).
const LM_TOOLS = [
  {
    name: 'gsd_progress',
    // skills/gsd-progress — real, verified: `gsd-tools.cjs progress json`.
    resolveCommand: () => ({ family: 'progress', subcommand: 'json', args: [] }),
  },
  {
    name: 'gsd_workstreams',
    // skills/gsd-workstreams — real, verified: `gsd-tools.cjs workstream list`.
    resolveCommand: () => ({ family: 'workstream', subcommand: 'list', args: [] }),
  },
  {
    name: 'gsd_plan_phase',
    // skills/gsd-plan-phase — real, verified: `gsd-tools.cjs phase-plan-index <phase>`.
    // (The full multi-step planning workflow stays slash-command-native; this
    // tool exposes the read-only plan-index lookup the workflow itself queries first.)
    resolveCommand: (input) => ({
      family: 'phase-plan-index',
      subcommand: undefined,
      args: [input && input.phase ? String(input.phase) : ''],
    }),
  },
];

/**
 * Builds a vscode.lm tool implementation for one LM_TOOLS entry.
 * @param {{name:string, resolveCommand:(input:object)=>{family:string,subcommand:string|undefined,args:string[]}}} toolDef
 * @param {object} vscode
 */
function createLanguageModelTool(toolDef, vscode) {
  return {
    async invoke(options, _token) {
      const input = (options && options.input) || {};
      // #2103 FIX: resolve the user's actual workspace, not the extension
      // host's process.cwd() — computed per-invocation. LanguageModelToolInvocationOptions
      // has no cwd field of its own.
      const cwd = resolveWorkspaceCwd(vscode);
      const { family, subcommand, args } = toolDef.resolveCommand(input);
      const result = JSON.parse(await dispatchGsdCommand({ family, subcommand, args, cwd }));
      const text = result.ok ? result.stdout : `GSD error: ${result.stderr || result.stdout || 'dispatch failed'}`;
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    },
  };
}

/**
 * Registers the LM_TOOLS set via vscode.lm.registerTool (#2103 UPGRADE 1).
 * Exported separately so it is testable with a mock `vscode.lm`.
 * @param {object} vscode
 * @param {import('vscode').ExtensionContext} context
 * @returns {number} count of tools registered (0 if vscode.lm is absent — fail-soft).
 */
function registerLanguageModelTools(vscode, context) {
  if (!vscode || !vscode.lm || typeof vscode.lm.registerTool !== 'function') return 0;
  let count = 0;
  for (const toolDef of LM_TOOLS) {
    const disposable = vscode.lm.registerTool(toolDef.name, createLanguageModelTool(toolDef, vscode));
    if (context && Array.isArray(context.subscriptions)) context.subscriptions.push(disposable);
    count++;
  }
  return count;
}

/** Mirrors capabilities/vscode/capability.json's hostIntegration.dispatch.maxDepth. */
const GSD_MAX_SUBAGENT_DEPTH = 5;

/**
 * #2103 UPGRADE 2 — native subagent dispatch (#runSubagent).
 *
 * Dispatches a command as a (possibly nested) subagent turn, enforcing GSD's
 * own maxDepth:5 ceiling (capabilities/vscode/capability.json) independent of
 * whatever VS Code's chat engine enforces natively for `#runSubagent` /
 * `chat.subagents.allowInvocationsFromSubagents` — belt-and-suspenders, never
 * silently trusts the host's own depth accounting.
 * @param {{family?:string, subcommand?:string, args?:string[], cwd?:string, depth?:number}} args
 * @returns {Promise<string>} same JSON-stringified contract as dispatchGsdCommand.
 */
async function dispatchAsSubagent(args) {
  const a = (args && typeof args === 'object') ? args : {};
  const depth = Number.isInteger(a.depth) ? a.depth : 0;
  if (depth > GSD_MAX_SUBAGENT_DEPTH) {
    return JSON.stringify({
      ok: false,
      stdout: '',
      stderr: `GSD subagent dispatch refused: depth ${depth} exceeds maxDepth ${GSD_MAX_SUBAGENT_DEPTH}`,
      code: null,
      timedOut: false,
    });
  }
  return dispatchGsdCommand(a);
}

/**
 * Detects whether the host VS Code build exposes the `#runSubagent` feature
 * surface (`chat.subagents.allowInvocationsFromSubagents`, VS Code 1.105+).
 * Fail-soft: any missing/older API surface (including an Insiders-gated build
 * where the setting does not exist yet) resolves `available:false` — never
 * throws. There is no separate registration call: VS Code's chat engine
 * surfaces the already-registered chat participant + languageModelTools to
 * `#runSubagent` on its own; this function only reports/confirms availability.
 * @param {object} vscode
 * @returns {{available: boolean, dispatchAsSubagent: typeof dispatchAsSubagent, maxDepth: number}}
 */
function registerSubagentDispatch(vscode) {
  let available = false;
  try {
    const cfg = vscode && vscode.workspace && typeof vscode.workspace.getConfiguration === 'function'
      ? vscode.workspace.getConfiguration('chat.subagents')
      : null;
    available = !!(cfg && typeof cfg.get === 'function' && cfg.get('allowInvocationsFromSubagents') !== undefined);
  } catch {
    available = false;
  }
  return { available, dispatchAsSubagent, maxDepth: GSD_MAX_SUBAGENT_DEPTH };
}

/**
 * VS Code extension activation. Composes the IDE-profile seams (per the #1933
 * reference binding) + registers the full command surface: palette
 * (gsd.invoke), chat participant (@gsd), Language Model Tools, and the
 * #runSubagent depth-cap wiring.
 * @param {import('vscode').ExtensionContext} context
 */
function activate(context) {
  const vscode = require('vscode');

  // ── Command surface: palette ──────────────────────────────────────────────
  // #2103 FIX: wrap dispatchGsdCommand (rather than registering it directly as
  // the handler) so a palette invocation that omits `cwd` resolves the user's
  // actual workspace instead of silently defaulting to the extension host's
  // own process.cwd(). An explicit `args.cwd` (e.g. from a programmatic
  // vscode.commands.executeCommand('gsd.invoke', {..., cwd}) caller) still
  // takes precedence.
  const gsdCommand = vscode.commands.registerCommand('gsd.invoke', (args) => {
    const a = (args && typeof args === 'object') ? args : {};
    const cwd = a.cwd || resolveWorkspaceCwd(vscode);
    return dispatchGsdCommand({ ...a, cwd });
  });
  context.subscriptions.push(gsdCommand);

  // ── IDE-profile host binding (#1933 reference binding; desktop/Node only —
  // see host-binding.js's header for why browser.js does NOT use this path).
  // On a real desktop VS Code host this SUCCEEDS (#2103 fix: host-binding.js's
  // guard checks vscode.lm.selectChatModels — the real API — not the
  // nonexistent vscode.lm.sendRequest the pre-#2103 code assumed). Still
  // wrapped fail-open so a genuinely older VS Code build (no vscode.lm at all)
  // degrades to the palette command only, rather than blocking activation.
  try {
    const bindGsdToVscode = require('./host-binding.js');
    const hostStorage = {
      read: (key) => context.globalState.get(key),
      write: (key, value) => context.globalState.update(key, value),
    };
    bindGsdToVscode(vscode, hostStorage);
  } catch {
    // fail-open — see doc comment above.
  }

  // ── Chat participant (@gsd) ───────────────────────────────────────────────
  registerChatParticipant(vscode, context);

  // ── Language Model Tools (#2103 UPGRADE 1) ────────────────────────────────
  registerLanguageModelTools(vscode, context);

  // ── #runSubagent wiring (#2103 UPGRADE 2) ─────────────────────────────────
  registerSubagentDispatch(vscode);
}

module.exports = {
  activate,
  dispatchGsdCommand,
  resolveEngineRoot,
  resolveWorkspaceCwd,
  parseChatPrompt,
  registerChatParticipant,
  registerLanguageModelTools,
  registerSubagentDispatch,
  dispatchAsSubagent,
  LM_TOOLS,
  GSD_MAX_SUBAGENT_DEPTH,
};
