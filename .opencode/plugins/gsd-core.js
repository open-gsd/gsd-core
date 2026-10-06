/**
 * GSD plugin for OpenCode.ai  (CommonJS)

 * Dual-runtime entry (issue #4916 port): the enumerable `server` export below
 * serves OpenCode V1; the non-enumerable `id`/`setup` pair serves the V2
 * plugin contract ({ id, setup | effect }). See the export-shape comment at
 * the bottom of this file and PROBE-FINDINGS.md for the runtime evidence.
 *
 * Architecture: SUBPROCESS REUSE. Instead of re-implementing hook logic inside
 * the plugin, this file is a thin adapter that spawns the existing Claude Code
 * hook scripts under hooks/ as child processes. The hooks speak a stable
 * protocol (JSON on stdin, JSON + exit code on stdout); this adapter:
 *   1. Translates OpenCode plugin events into Claude Code hook payloads
 *   2. Spawns `node <HOOKS_DIR>/<hook>.js` with the payload on stdin
 *   3. Translates hook output back into OpenCode semantics
 *      - block  → throw Error (OpenCode returns the error to the model)
 *      - advisory → output.metadata + console.error (best-effort surfacing)
 *
 * Namespace conversion (/gsd:xxx → /gsd-xxx) reuses scripts/fix-slash-commands.cjs
 * via require(), keeping the single source of truth.
 *
 * ── Two distribution shapes, one adapter (issue #1914) ─────────────────────
 * This single file serves both distribution paths, distinguished at load time
 * by REPO_ROOT (path.resolve(__dirname, "../..")):
 *
 *   • Option 1 — file copy (the supported GSD path). `bin/install.js` copies
 *     this file to <opencodeConfigDir>/plugins/gsd-core.js, so REPO_ROOT is the
 *     OpenCode config dir. GSD's own install already stages `hooks/*.js` and
 *     `gsd-core/` there (ADR-857 skips hook *registration* for OpenCode, not the
 *     file copy), so the hook bridge and content rewriting resolve natively.
 *     Commands/agents/skills are ALREADY registered by GSD's native file copy in
 *     this mode, so the plugin's own config-hook registration is redundant and is
 *     SKIPPED (see IS_PACKAGE_TREE) to avoid double-registration.
 *
 *   • Option 2 — package / git-spec. When loaded from the package tree (npm
 *     `main`, or an OpenCode git-spec install), REPO_ROOT is the package root and
 *     the source layout (commands/gsd/, agents/, skills/) is present. Here the
 *     plugin IS the sole registrar, so it registers commands/agents/skills too.
 *
 * IS_PACKAGE_TREE keys off the presence of the SOURCE command layout
 * (commands/gsd/), which only exists in the package tree — never in an installed
 * config dir (that uses the flattened command/ layout). The hook bridge and
 * Read-time content rewriting run in BOTH modes; only the config-hook
 * registration of commands/agents/skills is gated.
 *
 * Runtime-specific hooks are deliberately excluded:
 *   - gsd-statusline.js / gsd-update-banner.js (Claude Code statusline)
 *   - gsd-cursor-*.js (Cursor-specific)
 *   - *.sh scripts (invoked directly by commands/agents, not hook events)
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

// Resolve REPO_ROOT to the directory that actually holds the GSD payload
// (hooks/ + gsd-core/). This must work across three physical layouts because a
// single adapter file serves both distribution shapes (see header):
//   • package/git-spec tree:  <root>/.opencode/plugins/gsd-core.js   → <root>
//   • global file-copy:       ~/.config/opencode/plugins/gsd-core.js → ~/.config/opencode
//   • local file-copy:        <proj>/.opencode/plugins/gsd-core.js   → <proj>/.opencode
// A fixed "../.." only works for the first; the copied layouts sit one level
// shallower. Walking up to the first ancestor containing BOTH payload markers
// resolves all three deterministically. Falls back to the package-tree
// assumption ("../..") if no ancestor matches (keeps graceful degradation).
function resolveRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (
      fs.existsSync(path.join(dir, "hooks")) &&
      fs.existsSync(path.join(dir, "gsd-core"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  // No ancestor carried both markers (broken/partial layout — the plugin can't
  // function regardless). Fall back to the package-tree assumption ("../.."),
  // matching the historical fixed-depth behavior and the .opencode/plugins/
  // source layout.
  return path.resolve(startDir, "../..");
}

// CJS: __dirname is a global, no need to derive from import.meta.url
const REPO_ROOT = resolveRepoRoot(__dirname);
const HOOKS_DIR = path.join(REPO_ROOT, "hooks");
const COMMANDS = path.join(REPO_ROOT, "commands", "gsd");
const AGENTS = path.join(REPO_ROOT, "agents");
const SKILLS = path.join(REPO_ROOT, "skills");
const GSD_CORE = path.join(REPO_ROOT, "gsd-core");

// True only when loaded from the package/source tree (Option 2), detected by the
// presence of the SOURCE command layout (commands/gsd/). In an installed OpenCode
// config dir (Option 1) this directory is absent — the flattened command/ layout
// is used instead — so the plugin skips its own command/agent/skill registration
// and lets GSD's native file copy own that surface (avoids double-registration).
const IS_PACKAGE_TREE = fs.existsSync(COMMANDS);

// ---------------------------------------------------------------------------
// Namespace conversion — reuse the single source of truth
// ---------------------------------------------------------------------------

let _cmdNames = null;
let _transformFn = null;

/**
 * Lazily load scripts/fix-slash-commands.cjs and cache the transform function
 * + command name list. Returns null if the module is unavailable (the plugin
 * still works, just without namespace conversion).
 */
function getNamespaceConverter() {
  if (_transformFn) return _transformFn;
  try {
    const mod = require(
      path.join(REPO_ROOT, "scripts", "fix-slash-commands.cjs"),
    );
    _cmdNames = mod.readCmdNames();
    _transformFn = mod.transformContentToHyphen;
    return _transformFn;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session state — tracked across plugin hook invocations
// ---------------------------------------------------------------------------

let currentSessionId = null;
let currentCwd = process.cwd();

// ---------------------------------------------------------------------------
// Tool name / argument mapping  (OpenCode ↔ Claude Code)
// ---------------------------------------------------------------------------

const TOOL_NAME_MAP = {
  read: "Read",
  grep: "Grep",
  glob: "Grep", // V2 built-in (rev 4: same Claude-side target as grep)
  write: "Write",
  edit: "Edit",
  patch: "MultiEdit", // V2 built-in; input carries patchText (see mapToolInput)
  apply_patch: "MultiEdit",
  multi_edit: "MultiEdit",
  bash: "Bash",
  shell: "Bash", // V2 built-in
  webfetch: "WebFetch",
  web_search: "WebSearch",
  websearch: "WebSearch",
  task: "Task",
  subagent: "Task",
  // V2 `execute` (Code Mode) has no Claude-side equivalent and no guard keys
  // on its name — it passes through unmapped. Nested calls made from inside
  // execute scripts skip tool hooks entirely (probe OQ-10); the
  // permission.evaluate backstop in setup() covers out-of-tree writes.
};

function mapToolName(tool) {
  if (!tool) return "";
  return TOOL_NAME_MAP[String(tool).toLowerCase()] || tool;
}

// Build a Claude-style `tool_input` object from OpenCode's `output.args`.
function mapToolInput(args) {
  const input = {};
  if (!args || typeof args !== "object") return input;

  // File-path keys (OpenCode uses filePath/path; Claude uses file_path)
  const filePath = args.filePath || args.path || args.file_path;
  if (filePath) input.file_path = filePath;

  // Content for Write
  if (args.content !== undefined) input.content = args.content;

  // Edit patch fields
  if (args.new_string !== undefined) input.new_string = args.new_string;
  if (args.newString !== undefined) input.new_string = args.newString;
  if (args.old_string !== undefined) input.old_string = args.old_string;
  if (args.oldString !== undefined) input.old_string = args.oldString;

  // Bash command
  if (args.command !== undefined) input.command = args.command;

  // Grep file filter (OpenCode uses include; Claude uses glob)
  const glob = args.glob ?? args.include;
  if (glob !== undefined) input.glob = glob;

  // Web
  if (args.url !== undefined) input.url = args.url;
  if (args.query !== undefined) input.query = args.query;

  // Patch tool (V2): the input carries a patchText body with
  // *** Add File / *** Update File / *** Delete File / *** Move to headers
  // and NO file_path — without this extraction every path-based guard
  // (worktree, workflow, secret) stays dormant for patch writes. The guard
  // scripts read tool_input.file_path only (their `path` fallback aside), so
  // point it at the first affected path and keep the full list alongside;
  // multi-file patches alarm-log once per session because the guards
  // validate the first path only (hooks/*.js changes are out of scope).
  const patchText =
    typeof args.patchText === "string" ? args.patchText :
    typeof args.patch === "string" ? args.patch :
    typeof args.text === "string" ? args.text :
    null;
  if (patchText) {
    const affected = [];
    for (const line of patchText.split("\n")) {
      const m = /^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/.exec(line);
      if (m) affected.push(m[1]);
    }
    if (affected.length) {
      if (!input.file_path) input.file_path = affected[0];
      input.file_paths = affected;
      input.patch_text = patchText;
      if (affected.length > 1 && !warnedMultiPatch) {
        warnedMultiPatch = true;
        console.error(
          "[gsd-core] patch touches " + affected.length + " files; path guards " +
            "validated the first only (" + affected.join(", ") + ")",
        );
      }
    }
  }

  return input;
}

// ---------------------------------------------------------------------------
// Hook subprocess runner
// ---------------------------------------------------------------------------

/**
 * Spawn a Claude Code hook script and pipe a JSON payload to its stdin.
 *
 * Hooks follow the convention:
 *   - stdout: JSON object (decision/advisory) or empty
 *   - exit 0: allow (with optional advisory JSON on stdout)
 *   - exit 2: block (Claude convention; reason in stdout JSON)
 *   - any error: exit 0 silently (hooks swallow their own errors)
 *
 * @param {string} hookFile  filename under hooks/, e.g. "gsd-prompt-guard.js"
 * @param {object} payload   stdin JSON (hook_event_name, tool_name, ...)
 * @param {object} [opts]
 * @param {number} [opts.timeout=8000] spawn timeout in ms
 * @param {string} [opts.cwd]         working directory for the child
 * @returns {{ stdout: string, exitCode: number, timedOut: boolean }}
 */
const warnedMissingHooks = new Set();
let warnedMultiPatch = false; // one multi-file-patch alarm per session (see mapToolInput)

// ---------------------------------------------------------------------------
// Node interpreter resolution for the subprocess hook bridge (V2 port)
// ---------------------------------------------------------------------------
//
// V1's plugin host was Node, so `process.execPath` was a real node binary and
// spawnSync(process.execPath, [hookPath]) just worked. V2's host can be a
// Bun-compiled binary — observed live: process.execPath === the `opencode`
// binary itself (Bun v26.3.0) — and spawning THAT with a hook script path
// runs the OpenCode CLI instead of the script (exit 1, empty stdout, every
// guard silently inert). Resolve a real node before spawning; the last-resort
// bare "node" is PATH-resolved at spawn time.

let _resolvedNodeBin = null;

function resolveNodeBin() {
  if (_resolvedNodeBin) return _resolvedNodeBin;
  const candidates = [];
  if (process.env.GSD_NODE_BIN) candidates.push(process.env.GSD_NODE_BIN);
  if (path.basename(String(process.execPath || "")) === "node") {
    candidates.push(process.execPath); // node-based host (V1, or a node V2 host)
  }
  // Synchronous PATH scan — covers fnm/nvm multishells inherited from the
  // host process (dead multishell symlinks fail existsSync and are skipped).
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "node"));
  }
  // fnm's stable version store (survives ephemeral multishell cleanup).
  const fnmDir =
    process.env.FNM_DIR || path.join(os.homedir(), ".local", "share", "fnm");
  try {
    const versions = fs
      .readdirSync(path.join(fnmDir, "node-versions"))
      .sort()
      .reverse();
    for (const v of versions) {
      candidates.push(
        path.join(fnmDir, "node-versions", v, "installation", "bin", "node"),
      );
    }
  } catch {}
  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node");
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        _resolvedNodeBin = c;
        return c;
      }
    } catch {}
  }
  return (_resolvedNodeBin = "node");
}


// A hook this adapter kills on timeout has no exit status, so runHook below
// reports it as exit 0 — an ALLOW. For a guard that blocks, a bound shorter
// than the guard's own worst case therefore silently disables the gate. The
// two guards that probe git (worktree path, workflow force-add) run up to
// BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES sequential probes of
// BLOCKING_GUARD_PROBE_TIMEOUT_MS each (hooks/lib/git-probe.js, #5180), so
// their bound is that product plus a margin for node start/kill/reap. Read
// from the staged hooks/lib so it can never drift from the guards' own budget;
// the fallback is used only when that lib is missing from a partial install,
// and is sized for the same worst case.
const GIT_PROBING_GUARDS = new Set([
  "gsd-worktree-path-guard.js",
  "gsd-workflow-guard.js",
]);
const GIT_PROBING_GUARD_MARGIN_MS = 5000;
const GIT_PROBING_GUARD_FALLBACK_TIMEOUT_MS = 20000;

function gitProbingGuardTimeoutMs() {
  try {
    const probe = require(path.join(HOOKS_DIR, "lib", "git-probe.js"));
    const worstCaseMs =
      probe.BLOCKING_GUARD_MAX_SEQUENTIAL_PROBES *
      probe.BLOCKING_GUARD_PROBE_TIMEOUT_MS;
    if (Number.isFinite(worstCaseMs) && worstCaseMs > 0) {
      return worstCaseMs + GIT_PROBING_GUARD_MARGIN_MS;
    }
  } catch {
    // hooks/lib/git-probe.js unavailable — use the fallback below.
  }
  return GIT_PROBING_GUARD_FALLBACK_TIMEOUT_MS;
}

function runHook(hookFile, payload, opts = {}) {
  const hookPath = path.join(HOOKS_DIR, hookFile);
  if (!fs.existsSync(hookPath)) {
    // A missing guard script means the guard is silently NOT enforced — the
    // exact failure mode of #2305 (plugin staged, hooks bundle not). Never
    // break the tool call (the adapter's design contract), but never be
    // silent about it either: warn loudly, once per hook file.
    if (!warnedMissingHooks.has(hookFile)) {
      warnedMissingHooks.add(hookFile);
      console.error(
        `[gsd-core] hook script missing: ${hookPath} — ${hookFile} is NOT ` +
          "enforced. The GSD install may be incomplete; reinstall (or run " +
          "/gsd-update) to restage the hooks/ bundle.",
      );
    }
    return { stdout: "", exitCode: 0, timedOut: false };
  }
  const timeout =
    opts.timeout ??
    (GIT_PROBING_GUARDS.has(hookFile) ? gitProbingGuardTimeoutMs() : 8000);
  let result;
  try {
    result = spawnSync(resolveNodeBin(), [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout,
      cwd: opts.cwd || currentCwd,
      windowsHide: true,
    });
  } catch (e) {
    // Spawn failure — never break the tool call, but never be silent about
    // a broken interpreter either: a dead spawn means a dead guard.
    if (!warnedMissingHooks.has("spawn:" + hookFile)) {
      warnedMissingHooks.add("spawn:" + hookFile);
      console.error(
        `[gsd-core] hook spawn failed (${hookFile}):`,
        e && e.message,
        "— guard NOT enforced. Set GSD_NODE_BIN to a working node binary.",
      );
    }
    return { stdout: "", exitCode: 0, timedOut: false };
  }

  const stdout = (result.stdout || "").trim();
  const exitCode = result.status == null ? 0 : result.status;
  return { stdout, exitCode, timedOut: result.signal === "SIGTERM" };
}

/**
 * In-process check for whether context-usage warnings are disabled in project
 * config. Mirrors the exact semantics of the same check inside
 * hooks/gsd-context-monitor.js (introduced by #1073): an explicit
 * `config.hooks.context_warnings === false` disables them; a missing or
 * unparseable .planning/config.json keeps them enabled (the default).
 *
 * #2697: hoisting this check in-process lets the adapter SKIP the context-monitor
 * spawn entirely when the user has opted out, instead of paying a full Node boot
 * inside the child only to read the boolean and exit. Missing/unparseable config
 * MUST behave identically to the hook (enabled) so the default path is unchanged.
 *
 * @param {string} cwd  project working directory (the plugin's currentCwd)
 * @returns {boolean} true when context warnings are explicitly disabled
 */
function contextWarningsDisabled(cwd) {
  try {
    const configPath = path.join(cwd, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.hooks?.context_warnings === false;
  } catch {
    // Missing or unparseable config → proceed with defaults (context warnings enabled).
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hook output translation → OpenCode semantics
// ---------------------------------------------------------------------------

/**
 * Parse a hook's stdout and apply its effect to the OpenCode output object.
 *
 * - Block   → throw Error(parsed.reason) so OpenCode aborts the tool call
 * - Advisory→ append to output.metadata._gsdAdvisory[] and log to stderr
 * - Silent  → no-op
 *
 * @param {{ stdout: string, exitCode: number }} hookResult
 * @param {object} [output]  OpenCode mutable output object (optional)
 */
function handleHookResult(hookResult, output) {
  const { stdout, exitCode } = hookResult;
  if (!stdout && exitCode !== 2) return; // silent allow

  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // Non-JSON stdout (e.g. a stray log) — treat exit 2 as hard block, else allow
    }
  }

  // Block: explicit decision OR Claude exit-code-2 convention
  const isBlock = exitCode === 2 || (parsed && parsed.decision === "block");
  if (isBlock) {
    const reason =
      (parsed && parsed.reason) || "Blocked by GSD hook (no reason provided).";
    throw new Error(reason);
  }

  // Advisory: inject additionalContext into metadata + log
  const advisory =
    parsed &&
    parsed.hookSpecificOutput &&
    parsed.hookSpecificOutput.additionalContext;
  if (advisory) {
    if (output) {
      output.metadata = output.metadata || {};
      // Accumulate: a single tool call can run several advisory hooks in
      // sequence (prompt guard, read guard, worktree guard, workflow guard).
      // Storing a scalar would let a later advisory clobber an earlier one, so
      // collect them all.
      if (!Array.isArray(output.metadata._gsdAdvisory)) {
        output.metadata._gsdAdvisory = [];
      }
      output.metadata._gsdAdvisory.push(advisory);
    }
    // Best-effort visibility when metadata isn't surfaced to the model
    console.error(advisory);
  }
}

// ---------------------------------------------------------------------------
// Frontmatter helpers (for config registration)
// ---------------------------------------------------------------------------

// A self-contained copy of `locateFrontmatterFence` (src/frontmatter-fence.cts, the
// one frontmatter fence owner). Kept here, not required from the built
// gsd-core/bin/lib/frontmatter-fence.cjs, because this plugin must load in every
// layout it is copied to — including a package/git-spec tree, which may carry no
// built bin/lib. Found while implementing #5105: tests/frontmatter-fence.test.cjs
// ("kept frontmatter fence copies agree with the owner") pins this copy to the owner
// over a fixture corpus and a property test, and
// scripts/lint-frontmatter-fence-drift.cjs allowlists exactly this function.
function locateFrontmatterFence(text) {
  if (typeof text !== "string") {
    throw new TypeError(`locateFrontmatterFence: expected a string, got ${typeof text}`);
  }
  const closingFenceLine = /^---[ \t]*$/;
  const lenientClosingFenceLine = /^-{4,}[ \t]*$/;
  const bom = text.charCodeAt(0) === 0xfeff ? text.slice(0, 1) : "";
  const start = bom.length;
  let eol;
  if (text.startsWith("---\r\n", start)) eol = "\r\n";
  else if (text.startsWith("---\n", start)) eol = "\n";
  else return null;
  const openEnd = start + 3 + eol.length;
  const closedAt = (lineStart, lineEnd) => {
    let bodyEnd = openEnd;
    if (lineStart > openEnd) {
      bodyEnd = lineStart - 1;
      if (bodyEnd > openEnd && text[bodyEnd - 1] === "\r") bodyEnd -= 1;
    }
    return { bom, eol, openEnd, closed: true, closingStart: lineStart, closingFenceEnd: lineEnd, bodyEnd };
  };
  let lenient = null;
  let lineStart = openEnd;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline > lineStart && text[newline - 1] === "\r" ? newline - 1 : newline;
    const line = text.slice(lineStart, lineEnd);
    if (closingFenceLine.test(line)) return closedAt(lineStart, lineEnd);
    if (lenient === null && lenientClosingFenceLine.test(line)) lenient = [lineStart, lineEnd];
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  if (lenient !== null) return closedAt(lenient[0], lenient[1]);
  return { bom, eol, openEnd, closed: false, closingStart: -1, closingFenceEnd: -1, bodyEnd: text.length };
}

function parseFrontmatter(content) {
  const fence = locateFrontmatterFence(content);
  if (!fence || !fence.closed) return { frontmatter: {}, body: content };
  const fm = {};
  for (const line of content.slice(fence.openEnd, fence.bodyEnd).split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) {
      let v = line.slice(i + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      fm[line.slice(0, i).trim()] = v;
    }
  }
  // The body is everything past the closing fence line and its line ending.
  return { frontmatter: fm, body: content.slice(fence.closingFenceEnd).replace(/^\r?\n/, "") };
}

// Rewrite @~/.claude/ includes to point at the repo root.
// Also applies /gsd:xxx → /gsd-xxx namespace conversion via the shared
// transform from scripts/fix-slash-commands.cjs (single source of truth).
function rewriteRefs(content) {
  let out = content.replace(/@~\/\.claude\//g, `@${REPO_ROOT}/`);
  const transform = getNamespaceConverter();
  if (transform && _cmdNames && _cmdNames.length) {
    out = transform(out, _cmdNames);
  }
  return out;
}

function loadDir(dir, keyFn, valFn) {
  const result = {};
  if (!fs.existsSync(dir)) return result;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    result[keyFn(f)] = valFn(body, frontmatter, f);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Runtime content transform — for Read tool results on GSD-managed files
// ---------------------------------------------------------------------------

// Directories whose .md files may contain ~/.claude/ paths and gsd: namespace
// refs. When the model reads these via the Read tool, we transparently rewrite
// both so OpenCode sees correct paths and hyphen-form command names.
const GSD_MANAGED_DIRS = [
  path.join(GSD_CORE, "workflows"),
  path.join(GSD_CORE, "references"),
  path.join(GSD_CORE, "templates"),
  path.join(GSD_CORE, "contexts"),
  COMMANDS,
  AGENTS,
  SKILLS,
];

function isGsdManagedFile(filePath) {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  return GSD_MANAGED_DIRS.some(
    (dir) => resolved === dir || resolved.startsWith(dir + path.sep),
  );
}

// Rewrite content for OpenCode consumption:
//   1. @-include paths:  @~/.claude/  →  @<REPO_ROOT>/
//   2. plain-text paths: ~/.claude/gsd-core/  →  <GSD_CORE>/
//   3. namespace:        gsd:xxx  →  gsd-xxx  (via fix-slash-commands.cjs)
function rewriteContent(content) {
  let out = content;
  out = out.replace(/@~\/\.claude\//g, `@${REPO_ROOT}/`);
  out = out.replace(/~\/\.claude\/gsd-core\//g, `${GSD_CORE}/`);
  const transform = getNamespaceConverter();
  if (transform && _cmdNames && _cmdNames.length) {
    out = transform(out, _cmdNames);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Skills cache — copy SKILL.md files with rewritten @-include paths
// ---------------------------------------------------------------------------
//
// OpenCode's skill loader reads SKILL.md files directly from disk and resolves
// @-includes internally — this bypasses our tool.execute hooks. To make
// @~/.claude/gsd-core/... includes resolve, we copy all SKILL.md files to a
// cache directory with paths rewritten to the actual GSD_CORE location.
//
// Only used in package-tree mode (Option 2). In an installed OpenCode config
// dir (Option 1) skills are already staged + registered by GSD's native file
// copy, so we never register skills from the plugin (see IS_PACKAGE_TREE).

const SKILLS_CACHE = path.join(
  os.homedir(),
  ".cache",
  "opencode",
  "gsd-skills",
);

function prepareSkillsCache() {
  if (!fs.existsSync(SKILLS)) return null;
  fs.mkdirSync(SKILLS_CACHE, { recursive: true });
  for (const dir of fs.readdirSync(SKILLS)) {
    const srcFile = path.join(SKILLS, dir, "SKILL.md");
    if (!fs.existsSync(srcFile)) continue;
    const raw = fs.readFileSync(srcFile, "utf8");
    // Rewrite @-include paths only; namespace conversion is handled at
    // Read-time via tool.execute.after for workflow/reference files.
    const rewritten = raw
      .replace(/@~\/\.claude\/gsd-core\//g, `@${GSD_CORE}/`)
      .replace(/~\/\.claude\/gsd-core\//g, `${GSD_CORE}/`);
    const destDir = path.join(SKILLS_CACHE, dir);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, "SKILL.md"), rewritten);
  }
  return SKILLS_CACHE;
}

// ===========================================================================
// V2 helpers (OpenCode V2 plugin API — issue #4916 port; probe-verified on
// OpenCode 2.0.22/2.0.23 — see PROBE-FINDINGS.md)
// ===========================================================================

/**
 * $ARGUMENTS / $1…$n substitution for V2 command executors (Phase 4.1).
 * $ARGUMENTS = the full argument string; $1..$n = whitespace tokens
 * (missing tokens substitute empty). Documented fallback: template has no
 * placeholder and args are non-empty → append args after a blank line.
 */
function substituteCommandArgs(template, args) {
  const text = String(template || "");
  const argStr = String(args || "");
  const hasPlaceholder =
    text.includes("$ARGUMENTS") || /\$[1-9]/.test(text);
  if (!hasPlaceholder) {
    const trimmed = argStr.trim();
    return trimmed ? text + "\n\n" + trimmed : text;
  }
  const tokens = argStr.split(/\s+/).filter(Boolean);
  return text
    .replace(/\$ARGUMENTS/g, argStr)
    .replace(/\$([1-9][0-9]*)/g, (m, n) => tokens[Number(n) - 1] || "");
}

/**
 * Inline skill content for V2 registration: V2 resolves no `@` includes and
 * loads no supporting files (OQ-6), so content must be self-contained —
 * rewrite the canonical Claude paths to absolute GSD_CORE paths (same rules
 * as prepareSkillsCache).
 */
function rewriteSkillBody(raw) {
  return raw
    .replace(/@~\/\.claude\/gsd-core\//g, `@${GSD_CORE}/`)
    .replace(/~\/\.claude\/gsd-core\//g, `${GSD_CORE}/`);
}

/**
 * V2 Read result content transform (replaces the V1 `output.output` rewrite).
 * The read tool's content lives in `result.output.content` (string) AND in
 * the model-visible `result.content[]` text parts (probe OQ-2) — rewrite
 * both so the transform reaches the model regardless of which field the
 * client renders. Runs BEFORE injection scanning so the scanner sees final
 * content (V1 ordering).
 */
function rewriteReadResult(event) {
  const result = event.result;
  if (!result) return;
  if (result.output && typeof result.output === "object") {
    if (typeof result.output.content === "string") {
      result.output.content = rewriteContent(result.output.content);
    }
  } else if (typeof result.output === "string") {
    result.output = rewriteContent(result.output);
  }
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (part && part.type === "text" && typeof part.text === "string") {
        part.text = rewriteContent(part.text);
      }
    }
  }
}

/**
 * Extract the model-visible text of a completed tool result (V2 shape) for
 * the injection scanner's `tool_response` payload (V1 used output.output).
 */
function readResultText(event) {
  const result = event.result;
  if (!result) return undefined;
  if (result.output && typeof result.output === "object") {
    if (typeof result.output.content === "string") return result.output.content;
  } else if (typeof result.output === "string") {
    return result.output;
  }
  if (Array.isArray(result.content)) {
    return result.content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return undefined;
}


// ===========================================================================
// Plugin entry
// ===========================================================================

const GsdCorePlugin = async ({ directory } = {}) => {
  if (directory) currentCwd = directory;

  return {
    // ── Config: register commands / agents / skills paths ──────────────
    // Only in package-tree mode (Option 2). In an installed config dir
    // (Option 1) GSD's native file copy already registered these, so the
    // plugin stays out of registration to avoid double-registering.
    config: async (config) => {
      if (!IS_PACKAGE_TREE) return;

      // Commands (commands/gsd/*.md → gsd-<name>)
      config.command = config.command || {};
      const cmds = loadDir(
        COMMANDS,
        (f) => "gsd-" + f.slice(0, -3),
        (body, fm, name) => ({
          template: rewriteRefs(body.trim()),
          description: fm.description || `GSD ${name.slice(0, -3)} command`,
        }),
      );
      for (const [k, v] of Object.entries(cmds)) {
        if (!config.command[k]) config.command[k] = v;
      }

      // Agents (agents/*.md)
      config.agent = config.agent || {};
      const agents = loadDir(
        AGENTS,
        (f) => f.slice(0, -3),
        (body, fm, name) => ({
          prompt: rewriteRefs(body.trim()),
          description: fm.description || `GSD ${name.slice(0, -3)} agent`,
          mode: fm.mode || "subagent",
        }),
      );
      for (const [k, v] of Object.entries(agents)) {
        if (!config.agent[k]) config.agent[k] = v;
      }

      // Skills — copy SKILL.md files to cache with rewritten @-include paths,
      // then register the cache directory. OpenCode's skill loader reads
      // SKILL.md from disk and resolves @-includes internally (bypassing our
      // tool.execute hooks), so we must pre-process the files.
      const skillsCache = prepareSkillsCache();
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      const skillsPath = skillsCache || SKILLS;
      if (!config.skills.paths.includes(skillsPath)) {
        config.skills.paths.push(skillsPath);
      }
    },

    // ── shell.env ───────────────────────────────────────────────────────
    "shell.env": async (_input, output) => {
      output.env = output.env || {};
      output.env.GSD_DIR = GSD_CORE;
    },

    // ── tool.execute.before — PreToolUse hooks ─────────────────────────
    "tool.execute.before": async (input, output) => {
      const claudeTool = mapToolName(input.tool);
      const toolInput = mapToolInput(output.args || {});
      const cwd = currentCwd;

      // 0. Read path rewrite — redirect ~/.claude/gsd-core/ to actual GSD_CORE
      //    so the model can read workflow/reference/template files that SKILL.md
      //    and command templates reference via the canonical Claude path.
      if (claudeTool === "Read" && toolInput.file_path) {
        const original = toolInput.file_path;
        const rewritten = original
          .replace(/^~\/\.claude\/gsd-core\//, GSD_CORE + "/")
          .replace(/(?:.*)\/\.claude\/gsd-core\//, GSD_CORE + "/");
        if (rewritten !== original) {
          const args = output.args || {};
          if (args.filePath) args.filePath = rewritten;
          else if (args.path) args.path = rewritten;
          else if (args.file_path) args.file_path = rewritten;
          else args.filePath = rewritten;
        }
      }

      const basePayload = {
        hook_event_name: "PreToolUse",
        cwd,
      };
      // NOTE: session_id intentionally omitted for PreToolUse hooks.
      // gsd-read-guard.js treats a non-empty session_id as a Claude Code
      // session and skips its advisory. On OpenCode we WANT the advisory.
      const prePayload = (overrides = {}) => ({
        ...basePayload,
        tool_name: claudeTool,
        tool_input: toolInput,
        ...overrides,
      });

      const isWriteLike = ["Write", "Edit", "MultiEdit"].includes(claudeTool);

      // 1. gsd-prompt-guard.js — injection scan on .planning/ writes
      if (claudeTool === "Write" || claudeTool === "Edit") {
        const r = runHook("gsd-prompt-guard.js", prePayload());
        handleHookResult(r, output);
      }

      // 2. gsd-read-guard.js — read-before-edit advisory
      if (claudeTool === "Write" || claudeTool === "Edit") {
        const r = runHook("gsd-read-guard.js", prePayload());
        handleHookResult(r, output);
      }

      // 3. gsd-worktree-path-guard.js — hard-block edits outside worktree
      if (isWriteLike) {
        const r = runHook("gsd-worktree-path-guard.js", prePayload());
        handleHookResult(r, output);
      }

      // 4. gsd-write-guard.js — hard-block catastrophic shrink of curated
      //    .planning/ artifacts (ROADMAP.md, milestones/*-ROADMAP.md, STATE.md)
      if (claudeTool === "Write") {
        const r = runHook("gsd-write-guard.js", prePayload());
        handleHookResult(r, output);
      }

      // 5. gsd-workflow-guard.js — workflow advisory + git-force-add block
      //    (covers Write/Edit/MultiEdit AND Bash force-add detection)
      if (isWriteLike || claudeTool === "Bash") {
        const r = runHook("gsd-workflow-guard.js", prePayload());
        handleHookResult(r, output);
      }

      // 6. gsd-secret-read-guard.js — hard-block reads of .env / .env.<suffix> /
      //    .secrets via Read (file_path), Grep (path or glob) and Bash (command)
      if (["Read", "Grep", "Bash"].includes(claudeTool)) {
        const r = runHook("gsd-secret-read-guard.js", prePayload());
        handleHookResult(r, output);
      }
    },

    // ── tool.execute.after — PostToolUse hooks ─────────────────────────
    "tool.execute.after": async (input, output) => {
      const claudeTool = mapToolName(input.tool);
      // NOTE: In the `after` hook, `args` lives on `input` (not `output`).
      // The `output` object only has { title, output, metadata }.
      const toolInput = mapToolInput(input.args || {});
      const cwd = currentCwd;

      // GSD content transform — rewrite paths + namespace in Read results
      // BEFORE injection scanning so the scanner sees the final content.
      if (
        claudeTool === "Read" &&
        output.output &&
        isGsdManagedFile(toolInput.file_path)
      ) {
        const content =
          typeof output.output === "string"
            ? output.output
            : String(output.output);
        output.output = rewriteContent(content);
      }

      // gsd-read-injection-scanner.js — scan Read/WebFetch/WebSearch results
      if (
        claudeTool === "Read" ||
        claudeTool === "WebFetch" ||
        claudeTool === "WebSearch"
      ) {
        const payload = {
          hook_event_name: "PostToolUse",
          tool_name: claudeTool,
          tool_input: toolInput,
          tool_response: output.output,
          cwd,
        };
        const r = runHook("gsd-read-injection-scanner.js", payload);
        handleHookResult(r, output);
        return;
      }

      // gsd-context-monitor.js — context usage warnings (Bash/Edit/Write/Task/...)
      // Only meaningful when a session_id is tracked (writes metrics sentinel).
      // #2697: skip the subprocess spawn entirely when context warnings are
      // explicitly disabled in project config — the hook would exit early anyway,
      // so hoisting the check in-process avoids paying a Node boot per tool call.
      // Missing/unparseable config = enabled (default), so the spawn still runs.
      if (currentSessionId && !contextWarningsDisabled(cwd)) {
        const payload = {
          hook_event_name: "PostToolUse",
          tool_name: claudeTool,
          tool_input: toolInput,
          session_id: currentSessionId,
          cwd,
        };
        const r = runHook("gsd-context-monitor.js", payload);
        handleHookResult(r, output);
      }
    },

    // ── experimental.session.compacting — PreCompact ───────────────────
    "experimental.session.compacting": async (_input, output) => {
      if (!currentSessionId) return;
      const payload = {
        hook_event_name: "PreCompact",
        session_id: currentSessionId,
        cwd: currentCwd,
      };
      const r = runHook("gsd-context-monitor.js", payload);
      handleHookResult(r, output);

      // Also inject a GSD compaction breadcrumb (mirrors the original plugin)
      output.context = output.context || [];
      output.context.push(
        `[GSD] Active session: ${currentSessionId}. Preserve any in-flight phase/plan state.`,
      );
    },

    // ── General event subscriptions ─────────────────────────────────────
    event: async ({ event }) => {
      // session.created → SessionStart hooks
      if (event.type === "session.created") {
        // Track session for context-monitor payloads.
        // SDK type EventSessionCreated: { properties: { info: Session } }
        // Session has `id` and `directory` (not `cwd`).
        const info = event.properties?.info;
        currentSessionId =
          info?.id || event.sessionID || event.session_id || null;
        if (info?.directory) currentCwd = info.directory;

        // gsd-ensure-canonical-path.js — no stdin dependency; silent
        runHook("gsd-ensure-canonical-path.js", {
          hook_event_name: "SessionStart",
          session_id: currentSessionId,
          cwd: currentCwd,
        });
        // gsd-check-update.js — spawns its own background worker; no stdin
        runHook("gsd-check-update.js", {
          hook_event_name: "SessionStart",
          session_id: currentSessionId,
          cwd: currentCwd,
        });
        return;
      }

      // file.edited → FileChanged hook (config.json reload)
      if (event.type === "file.edited") {
        // SDK type EventFileEdited: { properties: { file: string } }
        const filePath = event.properties?.file || event.filePath || "";
        if (!filePath.endsWith("config.json")) return;
        const cwd = event.properties?.cwd || currentCwd;
        const expected = path.join(cwd, ".planning", "config.json");
        if (path.resolve(filePath) !== path.resolve(expected)) return;

        const payload = {
          hook_event_name: "FileChanged",
          file_path: filePath,
          event: "change",
          cwd,
        };
        const r = runHook("gsd-config-reload.js", payload);
        // Advisory-only (additionalContext); surface to logs
        handleHookResult(r);
        return;
      }

      // session.idle ↔ Claude Stop lifecycle point (#1682 Slice 1b/c).
      // OpenCode fires session.idle when the run quiesces. GSD maps it to the
      // Stop equivalent — the opencode-subset lifecycle peer of compaction
      // (compaction preserves state across context-window summarization; idle
      // marks end-of-turn). No-op sentinel today (GSD state is already
      // persisted to .planning/), but it MUST be recognized so the declared
      // opencode-subset surface is fully wired and a future Stop-class hook can
      // attach without a plugin change.
      if (event.type === "session.idle") {
        return;
      }

      // permission.asked / permission.replied — OpenCode permission lifecycle
      // (#2087, opencode.ai/docs/plugins). GSD gates tool INPUTS at
      // tool.execute.before (read-guard, injection-scanner); the permission
      // grant/deny decision itself carries no GSD workflow-phase contribution,
      // so these are recognized sentinels — wired so a future permission-aware
      // gate can attach without a plugin change (the engine owns phase
      // sequencing; this host bus is session/tool/permission-scoped, never
      // phase-scoped — ADR-1239 §OpenCode).
      if (event.type === "permission.asked" || event.type === "permission.replied") {
        return;
      }

      // session.error — OpenCode session-error lifecycle point (#2087). No GSD
      // hook fires here today (loop state is already persisted to .planning/);
      // recognized so the declared extension-event surface is fully wired and a
      // future error-class hook can attach without a plugin change.
      if (event.type === "session.error") {
        return;
      }
    },
  };
};

// ===========================================================================
// V2 plugin entry — setup(ctx) (OpenCode V2 plugin API; issue #4916 port)
// ===========================================================================
//
// V2 schema-decodes the default export as { id, setup | effect } and calls
// setup once PER LOCATION per server process — each instance gets a fresh
// module realm, so the module-level session state below is per-location
// (probe-verified on 2.0.22/23). The V1 `server` function above is never
// invoked by V2 and stays untouched for V1 runtimes. Surface mapping:
//
//   V1                              V2
//   ────────────────────────────────────────────────────────────────────────
//   arg `directory`                 ctx.location.directory
//   shell.env                       ctx.shell.hook("create.before", e => e.env)
//   tool.execute.before             ctx.tool.hook("execute.before") — args on
//                                   event.input; NO metadata slot on the event
//                                   → before-hook advisories are console.error
//                                   only (rev 3 decision)
//   tool.execute.after              ctx.tool.hook("execute.after") — status +
//                                   result{output, content[], metadata}; Read
//                                   text in result.output.content AND
//                                   result.content[].text (rewriteReadResult)
//   experimental.session.compacting ctx.session.hook("compaction") — breadcrumb
//                                   via event.system.push (probe OQ-8)
//   event: session.created          ctx.event.subscribe() + location filter —
//                                   payloads under event.data: sessionID +
//                                   location.directory (probe OQ-3)
//   event: session.moved (new)      refresh currentCwd (probe OQ-11)
//   event: file.edited              NO V2 EQUIVALENT (probe: zero file.* on
//                                   the bus) → config watcher + after-hook
//                                   bridge below
//   config hook (package tree)      ctx.command/ctx.skill transforms (Phase 4)
//
// Preserved invariants (rev 3/4):
//   • PreToolUse payloads omit session_id — gsd-read-guard.js:143-155 skips
//     its advisory when session_id is non-empty, and on OpenCode we want it.
//   • toolInput is built from args BEFORE the Read-path rewrite — hooks
//     chain and later registrations see the mutated input (probe OQ-9).
//   • The after-hook early-returns after the injection scanner: the context
//     monitor never spawns for Read/WebFetch/WebSearch (V1 :628-631).
//   • status === "error" → skip rewrite/scanner, still run context-monitor.

async function setup(ctx) {
  const locationDir =
    (ctx && ctx.location && typeof ctx.location.directory === "string" &&
      ctx.location.directory) ||
    process.cwd();
  currentCwd = locationDir;
  const myLocation = path.resolve(locationDir);
  const cleanups = [];

  // ── shell.env → create.before ────────────────────────────────────────────
  try {
    ctx.shell.hook("create.before", (event) => {
      event.env = event.env || {};
      event.env.GSD_DIR = GSD_CORE;
    });
  } catch (e) {
    console.error("[gsd-core] shell hook registration failed:", e && e.message);
  }

  // ── tool.execute.before — PreToolUse guards (V1 :515-591) ────────────────
  try {
    ctx.tool.hook("execute.before", (event) => {
      const claudeTool = mapToolName(event.tool);
      // Invariant: snapshot the guard-visible input BEFORE the Read-path
      // rewrite (hooks chain — later hooks see post-mutation input).
      const toolInput = mapToolInput(event.input || {});
      const cwd = currentCwd;

      // 0. Read path rewrite — redirect ~/.claude/gsd-core/ to GSD_CORE so
      //    the model can read workflow/reference/template files referenced
      //    by the canonical Claude path. Same key dance as V1, on the live
      //    input object (mutation honored — probe OQ-9).
      if (claudeTool === "Read" && toolInput.file_path) {
        const original = toolInput.file_path;
        const rewritten = original
          .replace(/^~\/\.claude\/gsd-core\//, GSD_CORE + "/")
          .replace(/(?:.*)\/\.claude\/gsd-core\//, GSD_CORE + "/");
        if (rewritten !== original) {
          const args = event.input || (event.input = {});
          if (typeof args.filePath === "string") args.filePath = rewritten;
          else if (typeof args.path === "string") args.path = rewritten;
          else if (typeof args.file_path === "string") args.file_path = rewritten;
          else args.filePath = rewritten;
        }
      }

      const basePayload = { hook_event_name: "PreToolUse", cwd };
      // NOTE: session_id intentionally omitted for PreToolUse hooks (V1
      // :541-543) — gsd-read-guard.js skips its advisory when session_id is
      // non-empty; on OpenCode we WANT the advisory.
      const prePayload = (overrides = {}) => ({
        ...basePayload,
        tool_name: claudeTool,
        tool_input: toolInput,
        ...overrides,
      });

      const isWriteLike = ["Write", "Edit", "MultiEdit"].includes(claudeTool);

      // 1–6: the identical V1 guard lattice. handleHookResult is called
      // WITHOUT a mutable output object on purpose — the V2 before-event
      // has no metadata slot, so advisories surface via console.error only.
      if (claudeTool === "Write" || claudeTool === "Edit") {
        handleHookResult(runHook("gsd-prompt-guard.js", prePayload()));
      }
      if (claudeTool === "Write" || claudeTool === "Edit") {
        handleHookResult(runHook("gsd-read-guard.js", prePayload()));
      }
      if (isWriteLike) {
        handleHookResult(runHook("gsd-worktree-path-guard.js", prePayload()));
      }
      if (claudeTool === "Write") {
        handleHookResult(runHook("gsd-write-guard.js", prePayload()));
      }
      if (isWriteLike || claudeTool === "Bash") {
        handleHookResult(runHook("gsd-workflow-guard.js", prePayload()));
      }
      if (["Read", "Grep", "Bash"].includes(claudeTool)) {
        handleHookResult(runHook("gsd-secret-read-guard.js", prePayload()));
      }
    });
  } catch (e) {
    console.error("[gsd-core] before hook registration failed:", e && e.message);
  }

  // ── .planning/config.json reload bridge (replaces V1 file.edited) ────────
  // file.edited does not exist on the V2 bus (probe OQ-3) — neither for tool
  // edits nor external writes. Two complementary triggers, debounced:
  //   a) the after-hook below fires on Write/Edit/MultiEdit of the file
  //      (covers GSD commands/agents, the common path), and
  //   b) fs.watch on <locationDir>/.planning (covers external editors).
  const reloadState = { timer: null };
  const queueConfigReload = (configPath) => {
    if (reloadState.timer) clearTimeout(reloadState.timer);
    reloadState.timer = setTimeout(() => {
      reloadState.timer = null;
      try {
        // Advisory-only (additionalContext); surface to logs
        handleHookResult(
          runHook("gsd-config-reload.js", {
            hook_event_name: "FileChanged",
            file_path: configPath,
            event: "change",
            cwd: currentCwd,
          }),
        );
      } catch (e) {
        console.error("[gsd-core] config reload failed", e);
      }
    }, 250);
  };

  // ── tool.execute.after — PostToolUse hooks (V1 :594-650) ─────────────────
  try {
    ctx.tool.hook("execute.after", (event) => {
      const claudeTool = mapToolName(event.tool);
      // Args live on the event's input in the after hook (same as V1).
      const toolInput = mapToolInput(event.input || {});
      const cwd = currentCwd;

      // Error path (rev 2/3 decision): skip rewrite + scanner (no content),
      // still run the context monitor — V1's after hook ran for every call.
      if (event.status === "error") {
        if (currentSessionId && !contextWarningsDisabled(cwd)) {
          handleHookResult(
            runHook("gsd-context-monitor.js", {
              hook_event_name: "PostToolUse",
              tool_name: claudeTool,
              tool_input: toolInput,
              session_id: currentSessionId,
              cwd,
            }),
            event.result,
          );
        }
        return;
      }

      // GSD content transform — rewrite paths + namespace in Read results
      // BEFORE injection scanning so the scanner sees the final content.
      if (claudeTool === "Read" && isGsdManagedFile(toolInput.file_path)) {
        rewriteReadResult(event);
      }

      // gsd-read-injection-scanner.js — Read/WebFetch/WebSearch, with the
      // V1 early return: the context monitor never spawns for these tools.
      if (
        claudeTool === "Read" ||
        claudeTool === "WebFetch" ||
        claudeTool === "WebSearch"
      ) {
        handleHookResult(
          runHook("gsd-read-injection-scanner.js", {
            hook_event_name: "PostToolUse",
            tool_name: claudeTool,
            tool_input: toolInput,
            tool_response: readResultText(event),
            cwd,
          }),
          event.result,
        );
        return;
      }

      // Config-reload bridge (a): tool edits of .planning/config.json.
      if (
        (claudeTool === "Write" || claudeTool === "Edit" || claudeTool === "MultiEdit") &&
        typeof toolInput.file_path === "string"
      ) {
        const expected = path.join(cwd, ".planning", "config.json");
        if (path.resolve(toolInput.file_path) === path.resolve(expected)) {
          queueConfigReload(expected);
        }
      }

      // gsd-context-monitor.js — context usage warnings. #2697: skip the
      // spawn entirely when explicitly disabled in project config; missing
      // or unparseable config = enabled (default), so the spawn still runs.
      if (currentSessionId && !contextWarningsDisabled(cwd)) {
        handleHookResult(
          runHook("gsd-context-monitor.js", {
            hook_event_name: "PostToolUse",
            tool_name: claudeTool,
            tool_input: toolInput,
            session_id: currentSessionId,
            cwd,
          }),
          event.result,
        );
      }
    });
  } catch (e) {
    console.error("[gsd-core] after hook registration failed:", e && e.message);
  }

  // Config-reload bridge (b): fs.watch fallback for external edits.
  const watchState = { root: null, planning: null };
  const planningDir = path.join(locationDir, ".planning");
  const configPath = path.join(planningDir, "config.json");
  const attachPlanningWatcher = () => {
    if (watchState.planning) return;
    try {
      watchState.planning = fs.watch(planningDir, (_ty, filename) => {
        if (filename === "config.json") queueConfigReload(configPath);
      });
      watchState.planning.on("error", () => {
        try { watchState.planning && watchState.planning.close(); } catch {}
        watchState.planning = null;
      });
    } catch { /* .planning absent — root watcher attaches it on creation */ }
  };
  try {
    attachPlanningWatcher();
    watchState.root = fs.watch(locationDir, (_ty, filename) => {
      if (filename === ".planning") attachPlanningWatcher();
    });
    watchState.root.on("error", () => {});
  } catch (e) {
    console.error("[gsd-core] config watcher unavailable:", e && e.message);
  }
  cleanups.push(() => {
    for (const w of [watchState.root, watchState.planning]) {
      try { w && w.close(); } catch {}
    }
    if (reloadState.timer) clearTimeout(reloadState.timer);
  });

  // ── experimental.session.compacting → session compaction (OQ-8) ─────────
  try {
    ctx.session.hook("compaction", (event) => {
      if (!currentSessionId) return;
      // No metadata slot on the compaction event → advisory → stderr only.
      handleHookResult(
        runHook("gsd-context-monitor.js", {
          hook_event_name: "PreCompact",
          session_id: currentSessionId,
          cwd: currentCwd,
        }),
      );
      // Breadcrumb: V1 pushed into output.context; V2 event.system is the
      // mutable SystemPart[] (probe-verified).
      event.system = event.system || [];
      event.system.push({
        type: "text",
        text: `[GSD] Active session: ${currentSessionId}. Preserve any in-flight phase/plan state.`,
      });
    });
  } catch (e) {
    console.error("[gsd-core] compaction hook registration failed:", e && e.message);
  }

  // ── permission.evaluate — Code-Mode deny-backstop (rev 4; probe OQ-10) ───
  // Nested tool calls made from inside `execute` scripts skip the tool hooks
  // above entirely; this is the only surface that still sees out-of-tree
  // writes made that way. Narrow by design: external_directory actions from
  // tools, hard-block guards only (advisories already ran on the before-hook
  // path for ordinary calls), synthesized minimal payload (the evaluate event
  // carries metadata.filepath but no tool input), deny only on block.
  try {
    ctx.permission.hook("evaluate", (event) => {
      if (!event || event.action !== "external_directory") return;
      if (!event.source || event.source.type !== "tool") return;
      const filePath =
        (event.metadata && typeof event.metadata.filepath === "string" &&
          event.metadata.filepath) || null;
      if (!filePath) return;
      const payload = {
        hook_event_name: "PreToolUse",
        cwd: currentCwd,
        tool_name: "Write",
        tool_input: { file_path: filePath },
        // session_id intentionally omitted (same invariant as above)
      };
      for (const guard of [
        "gsd-worktree-path-guard.js",
        "gsd-secret-read-guard.js",
      ]) {
        const r = runHook(guard, payload);
        let parsed = null;
        if (r.stdout) {
          try { parsed = JSON.parse(r.stdout); } catch {}
        }
        if (r.exitCode === 2 || (parsed && parsed.decision === "block")) {
          const reason = (parsed && parsed.reason) ||
            `Blocked by GSD hook (${guard}).`;
          console.error("[gsd-core] backstop deny:", reason);
          try { event.effect = "deny"; } catch {}
          return;
        }
      }
    });
  } catch (e) {
    console.error("[gsd-core] permission hook registration failed:", e && e.message);
  }

  // ── event subscription (V1 :671-749) with the location filter ────────────
  // The V2 stream is server-global — every subscribed plugin instance
  // receives every event — so state mutations are gated on the event's
  // location matching this instance's ctx.location.directory (issue #4916 +
  // probe OQ-3). session.idle never appears on the V2 bus and permission.* /
  // session.error carry no GSD action (rev 4) — those V1 sentinels are gone.
  const controller = new AbortController();
  const ownsEvent = (ev) => {
    const data = (ev && ev.data) || {};
    const dir = (ev.location && ev.location.directory) ||
      (data.location && data.location.directory);
    // State-mutating events always carry location; without it, skip.
    return typeof dir === "string" && !!dir && path.resolve(dir) === myLocation;
  };
  void (async () => {
    try {
      for await (const ev of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        try {
          if (!ev || typeof ev.type !== "string") continue;
          const data = ev.data || {};
          switch (ev.type) {
            case "session.created": {
              if (!ownsEvent(ev)) break;
              // Track session for context-monitor payloads. V2 payload:
              // { sessionID, projectID, location:{directory}, … } — no
              // `info` object (probe OQ-3).
              currentSessionId = data.sessionID || null;
              if (data.location && typeof data.location.directory === "string") {
                currentCwd = data.location.directory;
              }
              // gsd-ensure-canonical-path.js — no stdin dependency; silent
              runHook("gsd-ensure-canonical-path.js", {
                hook_event_name: "SessionStart",
                session_id: currentSessionId,
                cwd: currentCwd,
              });
              // gsd-check-update.js — spawns its own background worker
              runHook("gsd-check-update.js", {
                hook_event_name: "SessionStart",
                session_id: currentSessionId,
                cwd: currentCwd,
              });
              break;
            }
            case "session.moved": {
              // Keep the worktree root fresh — a moved session otherwise
              // compares guard paths against a stale cwd (probe OQ-11).
              if (!ownsEvent(ev)) break;
              if (data.sessionID) currentSessionId = data.sessionID;
              if (data.location && typeof data.location.directory === "string") {
                currentCwd = data.location.directory;
              }
              break;
            }
            default:
              break;
          }
        } catch (e) {
          console.error("[gsd-core] event error", e);
        }
      }
    } catch {
      /* abort is a normal exit */
    }
  })();
  cleanups.push(() => controller.abort());

  // ── package-tree registration (Option 2 distribution; Phase 4) ───────────
  if (IS_PACKAGE_TREE) {
    // Transforms are replayable state edits: keep callbacks synchronous,
    // cheap, side-effect-free — all file reads happen here, once, before
    // registration (challenge #10). The per-instance `registered` flags are
    // the no-overwrite guard (the command editor exposes only `add`, and
    // each location instance is a fresh module realm — probe rev 4).
    const commands = loadDir(
      COMMANDS,
      (f) => "gsd-" + f.slice(0, -3),
      (body, fm, name) => ({
        template: rewriteRefs(body.trim()),
        description: fm.description || `GSD ${name.slice(0, -3)} command`,
      }),
    );
    const skills = [];
    try {
      if (fs.existsSync(SKILLS)) {
        for (const dir of fs.readdirSync(SKILLS)) {
          const srcFile = path.join(SKILLS, dir, "SKILL.md");
          if (!fs.existsSync(srcFile)) continue;
          const raw = fs.readFileSync(srcFile, "utf8");
          const { frontmatter } = parseFrontmatter(raw);
          skills.push({
            id: dir,
            name: frontmatter.name || dir,
            description: frontmatter.description || "",
            // `path` per the installed schema (docs say `location` — wrong
            // on 2.0.22/23, probe OQ-6); content is rewritten inline.
            path: srcFile,
            content: rewriteSkillBody(raw),
          });
        }
      }
    } catch (e) {
      console.error("[gsd-core] skills scan failed:", e && e.message);
    }

    let commandsRegistered = false;
    try {
      ctx.command.transform((editor) => {
        if (commandsRegistered || !editor || typeof editor.add !== "function") return;
        commandsRegistered = true;
        for (const [name, def] of Object.entries(commands)) {
          editor.add({
            name,
            description: def.description,
            execute: async ({ sessionID, prompt }) => {
              const args = (prompt && prompt.text) || "";
              const text = substituteCommandArgs(def.template, args);
              try {
                await ctx.session.prompt({ ...(prompt || {}), sessionID, text });
              } catch (e) {
                console.error(`[gsd-core] command ${name} failed:`, e && e.message);
              }
            },
          });
        }
      });
    } catch (e) {
      console.error("[gsd-core] command transform failed:", e && e.message);
    }

    let skillsRegistered = false;
    try {
      ctx.skill.transform((editor) => {
        if (skillsRegistered || !editor || typeof editor.add !== "function") return;
        skillsRegistered = true;
        for (const s of skills) editor.add(s);
      });
    } catch (e) {
      console.error("[gsd-core] skill transform failed:", e && e.message);
    }

    // Agents: plugins cannot add agents on V2 — AgentEditor has no `add`
    // (probe OQ-5, matches @opencode/plugin 2.0.16). Package-mode installs
    // need GSD's installer to stage agents/*.md into a discovered agents/
    // dir (required companion change, out of scope here — PLAN Phase 4.2).
  }

  // ── cleanup (hot reload / unload) ────────────────────────────────────────
  return () => {
    for (const fn of cleanups) {
      try { fn(); } catch {}
    }
  };
}
// Export shape — verified against OpenCode's plugin loader source
// (packages/opencode/src/plugin). The loader imports this module and runs
// `for (const entry of Object.values(mod)) { getServerPlugin(entry) }`, where
// `getServerPlugin` accepts a bare function OR an object exposing a `.server`
// function, and THROWS `TypeError("Plugin export is not a function")` for
// anything else. So EVERY enumerable value the loader iterates must be a
// function or an object with `.server`.
//
// The subtlety: depending on how OpenCode's runtime (Node or Bun) imports a
// CommonJS file, `mod` may be the raw `module.exports` OR an ESM namespace of
// the form `{ default: module.exports, ...syntheticNamedExports }`. A plain
// `module.exports = { id: "gsd-core", server }` literal risks a string `id`
// appearing in `Object.values(mod)` (as a raw property, or as a lexer-
// synthesized named export) — which would trip the throw. Two defenses:
//   1. `id` is defined NON-ENUMERABLE, so it never appears in Object.values yet
//      stays readable (via property access) for the loader's identity/dedup.
//   2. `module.exports` is assigned from a VARIABLE (not an object literal), so
//      cjs-module-lexer cannot statically synthesize named exports from it —
//      only `default` is exposed under ESM/Bun interop.
// Result: raw-CJS `Object.values` = `[server]`; ESM `Object.values` =
// `[{server, <id non-enum>}]` — both fully extractable. Test-only helpers hang
// off the `server` FUNCTION (`server._internals`), never as a sibling export.
GsdCorePlugin._internals = {
  REPO_ROOT,
  IS_PACKAGE_TREE,
  mapToolName,
  mapToolInput,
  locateFrontmatterFence,
  parseFrontmatter,
  rewriteContent,
  isGsdManagedFile,
  handleHookResult,
  GsdCorePlugin,
  // V2 port test hooks
  setup,
  substituteCommandArgs,
  rewriteSkillBody,
  rewriteReadResult,
  readResultText,
};

const gsdCorePluginExport = { server: GsdCorePlugin };
Object.defineProperty(gsdCorePluginExport, "id", {
  value: "gsd-core",
  enumerable: false,
  writable: false,
  configurable: false,
});
// V2 (issue #4916): the V2 loader schema-decodes the default export as
// { id, setup | effect } and reads properties BY ACCESS (it read this file's
// hidden `id` fine while flagging only setup/effect missing). Keeping BOTH
// `id` and `setup` non-enumerable preserves every V1 iterator (raw-CJS
// Object.values stays [server]; cjs-module-lexer cannot synthesize named
// exports from a variable assignment) while satisfying the V2 contract.
Object.defineProperty(gsdCorePluginExport, "setup", {
  value: setup,
  enumerable: false,
  writable: false,
  configurable: false,
});
module.exports = gsdCorePluginExport;
