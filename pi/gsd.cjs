'use strict';

/**
 * GSD extension for pi (pi.dev) — ADR-1239 Phase D / #1944, upgraded #2102 Stage 2.
 *
 * pi is a Programmatic-CLI host whose TS extensions implement the ExtensionAPI
 * (`@earendil-works/pi-coding-agent`): registerCommand({handler(args, ctx)}) /
 * registerTool({execute(toolCallId, params, signal, onUpdate, ctx)}) / pi.on(event, handler).
 * This extension binds GSD's command surface to pi via the imperative adapter
 * path — the programmatic-CLI peer of the OpenCode worked binding.
 *
 * Installation: copy this file to ~/.pi/agent/extensions/gsd.js — note the
 * `.js` DEST suffix, not `.cjs`. pi auto-discovers extensions/ entries through
 * `isExtensionFile()`, which accepts only `.ts`/`.js` and skips anything else
 * SILENTLY (no error, no log line), so a `.cjs` dest installs fine and is then
 * never loaded (#2470). This source file keeps its `.cjs` suffix on purpose —
 * tests `require()` it directly and `.cjs` is unambiguous CommonJS — and pi
 * loads the copied file via jiti, which handles CommonJS and ESM alike, so the
 * suffix gates discovery, not parsing. The engine is resolved from the installed
 * GSD tree (walk-up like the OpenCode plugin). pi's shared hooks/ bundle
 * (hooks/*.js + hooks/lib/git-cmd.js) is installed alongside the extension —
 * capabilities/pi/capability.json does NOT set
 * `hostBehaviors.skipSharedHooksInstall` (#2102 Stage 2 fix; pi is
 * architecturally identical to OpenCode here: `hooksSurface: 'none'` +  a
 * native extension that spawns the staged hooks — not Kilo/ZCode's
 * no-plugin-surface case, where the same hooks would be genuine dead weight).
 * This is what makes the event bridges below (and the tokenizer require)
 * resolve for real in an installed tree, not just in this dev repo.
 *
 * Engine entry: dispatch is SUBPROCESS-REUSE to gsd-tools.cjs (bounded,
 * no-throw — dispatchGsdCommand in shell-command-projection.cjs), NOT an
 * in-process command-routing hub. No fully-populated hub factory exists
 * anywhere in gsd-core — every createHub() caller in the tree builds a
 * single-family hub for its own narrow purpose — so the "in-process createHub"
 * framing of the original #1944 cut was aspirational and is not achievable
 * without a hub factory that doesn't exist. This mirrors the precedent already
 * established for the OpenCode/Kilo hook bridge (.opencode/plugins/gsd-core.js
 * header: "Architecture: SUBPROCESS REUSE ... spawns existing hook scripts as
 * child processes") — the same pattern, applied to command dispatch. The
 * companion MCP server (gsd-mcp-server) dispatches through the SAME shared
 * helper for out-of-process hosts.
 *
 * @param {object} pi  pi ExtensionAPI (registerTool/registerCommand/on/…)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Resolve the GSD engine tree (the dir holding gsd-core/ + hooks/).
// Works across dev (<root>/pi/gsd.cjs → <root>) and installed layouts.
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

// #3023: pi reserves `hooks/` as its (now deprecated) extension directory and
// warns on every startup when one exists, so the installer stages GSD's shared
// hook bundle under `gsd-hooks/` for pi. Probe in preference order rather than
// hardcoding either name: an installed pi tree has `gsd-hooks/`, a dev checkout
// has the repo-root `hooks/`, and a half-upgraded tree can transiently have both
// — in which case the renamed bundle is the current one and wins.
const SHARED_HOOKS_DIR_CANDIDATES = ['gsd-hooks', 'hooks'];

/**
 * Absolute path to the staged shared-hook bundle, or null when none is present.
 * Never throws — a stat failure on any candidate is treated as "not this one".
 *
 * A candidate qualifies only when it is a directory AND non-empty. An install
 * can be interrupted between `mkdirSync(gsd-hooks)` and the file copy, leaving
 * a directory that exists but is empty; `gsd-hooks` is probed FIRST (it is the
 * preferred, current name), so an empty `gsd-hooks/` would otherwise win over
 * a fully-staged legacy `hooks/` and every hook would silently no-op —
 * `runHook`'s `fs.existsSync(hookPath)` guard degrades per-file, so binding to
 * an empty bundle produces no error at all, just silent inaction. A
 * partially-staged bundle must lose to a fully-staged one for that reason.
 * @param {string} engineRoot
 * @returns {string|null}
 */
function resolveSharedHooksDir(engineRoot) {
  for (const name of SHARED_HOOKS_DIR_CANDIDATES) {
    const candidate = path.join(engineRoot, name);
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
      if (fs.readdirSync(candidate).length === 0) continue;
      return candidate;
    } catch { /* absent or unreadable — try the next candidate */ }
  }
  return null;
}

const SHARED_HOOKS_DIR = resolveSharedHooksDir(ENGINE_ROOT);

// ── curated top-level command families (gsd-tools.cjs TOP_LEVEL_USAGE) ──────
// readCmdNames() (scripts/fix-slash-commands.cjs) reads commands/, which pi
// does NOT install (it ships a single native-extension file, no shared
// commands/ dir) — it would always return []. This is a self-contained,
// hand-curated subset of the STABLE top-level families documented by
// `node gsd-core/bin/gsd-tools.cjs --help` (gsd-tools.cjs:689-705). Named +
// exported (via _internals) so a test can assert against it directly.
const PI_COMMAND_FAMILIES = Object.freeze([
  'agent', 'capability', 'check', 'commit', 'config-get', 'config-path',
  'config-set', 'effort', 'git', 'graphify', 'init', 'intel', 'learnings',
  'list-todos', 'loop', 'milestone', 'phase', 'phases', 'progress',
  'requirements', 'research-plan', 'research-store', 'resolve-granularity',
  'resolve-model', 'roadmap', 'scaffold', 'smart-entry', 'state', 'task',
  'template', 'user-story', 'validate', 'verify', 'workstream', 'worktree',
]);

/**
 * Filter PI_COMMAND_FAMILIES by prefix (startsWith). Returns null when there
 * are no matches, per pi's `AutocompleteItem[]|null` contract.
 * @param {string} prefix
 * @returns {{value: string, label: string}[] | null}
 */
function getArgumentCompletions(prefix) {
  const p = typeof prefix === 'string' ? prefix : '';
  const matches = PI_COMMAND_FAMILIES.filter((name) => name.startsWith(p));
  if (matches.length === 0) return null;
  return matches.map((value) => ({ value, label: value }));
}

/**
 * Tokenize the raw `/gsd <args>` string into { family, subcommand, args }.
 * Reuses the quote-aware whitespace tokenizer already shipped for hooks
 * (the staged shared-hook bundle's `lib/git-cmd.js`'s `tokenize`) rather than
 * re-implementing shell-word splitting a second time. #2102 Stage 2: pi's capability descriptor no
 * longer sets `hostBehaviors.skipSharedHooksInstall` (adversarial-review
 * finding #1/#2 — pi ships NO hooks/ with that flag set, so this require was
 * dead in a real install), so the shared hooks/ bundle — including
 * hooks/lib/git-cmd.js — is installed alongside the extension for real
 * (mirrors OpenCode, whose native plugin also spawns the staged hooks/*.js
 * bundle). The require below is therefore the PRIMARY, live path in an
 * installed pi tree; the whitespace-split fallback stays as defense-in-depth
 * for a corrupted/partial install (e.g. a user who deleted hooks/lib/ by
 * hand) rather than the only-ever-taken path.
 * @param {string} rawArgs
 * @returns {{ family: string, subcommand?: string, args: string[] }}
 */
function parseGsdCommandArgs(rawArgs) {
  let tokenize;
  try {
    if (!SHARED_HOOKS_DIR) throw new Error('no staged hook bundle');
    ({ tokenize } = require(path.join(SHARED_HOOKS_DIR, 'lib', 'git-cmd.js')));
  } catch {
    tokenize = (s) => String(s || '').split(/\s+/).filter(Boolean);
  }
  const tokens = tokenize(typeof rawArgs === 'string' ? rawArgs : '');
  return {
    // Empty args → dispatch gsd-tools.cjs's own --help surface (a real,
    // working, ok:true default — NOT the 'query'/'help' pairing the original
    // #1944 cut used, which is not a valid gsd-tools.cjs command).
    family: tokens[0] || '--help',
    subcommand: tokens[1],
    args: tokens.slice(2),
  };
}

/**
 * Best-effort TypeBox schema for gsd_invoke's `parameters`, falling back to a
 * plain JSON-Schema object when the `typebox` package is unavailable (it is
 * NOT a gsd-core dependency — pi's own ExtensionAPI contract expects TypeBox,
 * but nothing in this repo installs it). TypeBox schemas ARE JSON Schema, so
 * the fallback object is structurally equivalent for hosts that accept plain
 * JSON Schema; this is a best-effort shim for the flat-file extension case.
 * @returns {object}
 */
function buildGsdInvokeParameters() {
  try {
    const typebox = require('typebox');
    const Type = typebox && typebox.Type;
    if (Type) {
      return Type.Object({
        family: Type.String(),
        subcommand: Type.Optional(Type.String()),
        args: Type.Optional(Type.Array(Type.String())),
      });
    }
  } catch {
    // typebox is not installed in this environment — fall through to the
    // plain JSON-Schema fallback below. This is the normal path (typebox is
    // NOT a gsd-core dependency), so no warning is emitted (#3022).
  }
  return {
    type: 'object',
    properties: {
      family: { type: 'string' },
      subcommand: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
    },
    required: ['family'],
  };
}

/**
 * Build the `before_provider_request` handler that steers pi's model
 * selection to GSD's tier-resolved id (modelMode: 'active' per
 * capabilities/pi/capability.json). GSD does NOT call `pi.registerProvider` —
 * that registers a NEW model provider; GSD's job here is only to pick a
 * tier-appropriate id AMONG pi's EXISTING built-in anthropic models, so
 * registerProvider would be the wrong primitive (it would wrongly add a fake
 * provider instead of steering the real one).
 *
 * v1 tier policy: GSD does not yet expose a per-turn/per-agent tier signal to
 * this event, so a conservative fixed default tier is used (parameterized —
 * default 'sonnet' — so a future richer signal, or a test, can override it).
 *
 * ASSUMPTION (flagged — verify against a live pi host): the event payload's
 * model field is named `model`, matching the anthropic-messages payload shape
 * (Context7-confirmed for the wire protocol; pi's own before_provider_request
 * event schema was not independently verifiable in this environment). If pi's
 * actual field name differs, this returns the WRONG key and pi's fail-open
 * default takes over only because bare-model-id mismatches degrade to
 * provider-level errors, not GSD-level ones — a discrepancy here needs a
 * live-host smoke test before shipping past this stage.
 *
 * Fail-open: any resolution failure (or a null/falsy resolved model — e.g. an
 * unrecognized tier) returns `undefined`, leaving pi's model choice untouched.
 * NEVER returns a payload with a missing/empty model id.
 *
 * @param {{ tier?: string }} [opts]
 * @returns {(event: object, ctx: object) => Promise<object|undefined>}
 */
function buildBeforeProviderRequestHandler({ tier = 'sonnet' } = {}) {
  return async function onBeforeProviderRequest(event, ctx) {
    try {
      const effectiveCwd = (ctx && ctx.cwd) || process.cwd();
      const { loadConfig } = require(path.join(GSD_CORE, 'bin', 'lib', 'config-loader.cjs'));
      const config = loadConfig(effectiveCwd);
      const overrides = (config && config.model_profile_overrides) || undefined;

      // #2460: FAIL-OPEN when the user has not explicitly configured
      // model_profile_overrides[runtime][tier]. pi is provider-agnostic
      // (kimi-coding, zai, openrouter, openai-codex, minimax, anthropic, …);
      // the built-in RUNTIME_PROFILE_MAP.pi.sonnet default is `claude-sonnet-5`,
      // an Anthropic-ecosystem assumption that is wrong for every non-Anthropic
      // provider. Returning the built-in default unconditionally rewrote every
      // outgoing request to a model the active provider did not know.
      //
      // resolveTierEntry falls back to the built-in catalog when no override is
      // present, so we cannot call it to detect "did the user opt in?" — we
      // inspect the override map directly. Only when the user has explicitly
      // set model_profile_overrides[runtime][tier] do we steer; otherwise we
      // return undefined and pi's chosen model flows through untouched.
      const userRaw = overrides && overrides.pi ? overrides.pi[tier] : undefined;
      // `''` is treated the same as null/undefined: an explicit empty-string
      // override is the user clearing a previously-set value, NOT opting in to
      // steering. Without this guard, `resolveTierEntry`'s falsy `if (userRaw)`
      // check would silently fall back to the built-in catalog and rewrite
      // payload.model to claude-sonnet-5 — re-introducing the exact bug this
      // handler exists to prevent.
      if (userRaw === undefined || userRaw === null || userRaw === '') {
        return undefined; // fail-open — leave pi's model untouched
      }

      const { resolveTierEntry } = require(path.join(GSD_CORE, 'bin', 'lib', 'model-resolver.cjs'));
      const entry = resolveTierEntry({ runtime: 'pi', tier, overrides });
      const modelId = entry && typeof entry.model === 'string' && entry.model.length > 0 ? entry.model : null;
      if (!modelId) return undefined; // fail-open — leave pi's model untouched
      const basePayload = (event && typeof event === 'object' && event.payload && typeof event.payload === 'object')
        ? event.payload
        : {};
      return { ...basePayload, model: modelId };
    } catch {
      return undefined; // fail-open on any resolution error
    }
  };
}

/**
 * Bounded subprocess bridge to GSD's Claude Code hook scripts. Mirrors
 * .opencode/plugins/gsd-core.js's `runHook` (SUBPROCESS-REUSE): spawns
 * `node <hooks/hookFile>` with the payload piped to stdin, on a bounded
 * timeout. NEVER throws — a missing hook file, a spawn error, or a timeout
 * all degrade to a silent-allow result so a hook problem can never block pi.
 * @param {string} hookFile  filename under the resolved shared-hook bundle, e.g. "gsd-context-monitor.js"
 * @param {object} payload
 * @param {{ timeout?: number, cwd?: string }} [opts]
 * @returns {{ stdout: string, exitCode: number, timedOut: boolean }}
 */
function runHook(hookFile, payload, opts = {}) {
  if (!SHARED_HOOKS_DIR) return { stdout: '', exitCode: 0, timedOut: false };
  const hookPath = path.join(SHARED_HOOKS_DIR, hookFile);
  if (!fs.existsSync(hookPath)) return { stdout: '', exitCode: 0, timedOut: false };
  const timeout = opts.timeout || 8000;
  let result;
  try {
    result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload || {}),
      encoding: 'utf8',
      timeout,
      cwd: opts.cwd || process.cwd(),
      windowsHide: true,
    });
  } catch {
    return { stdout: '', exitCode: 0, timedOut: false };
  }
  const stdout = (result && typeof result.stdout === 'string') ? result.stdout.trim() : '';
  const exitCode = (result && result.status != null) ? result.status : 0;
  return { stdout, exitCode, timedOut: !!(result && result.signal === 'SIGTERM') };
}

// ── workflow hand-off (#5547) ─────────────────────────────────────────────────
// `/gsd <command>` used to be a data dispatcher only: `/gsd init new-project`
// printed the init JSON and stopped, because Pi had no entry point that mapped a
// GSD command to its workflow. The installer now writes each command as a Pi
// skill (`<config>/skills/gsd-<command>/SKILL.md`, invoked `/skill:gsd-<command>`),
// so a command that names one of those skills hands off to it instead.

// `/gsd init <workflow>` is a data call (the init bundle a workflow consumes).
// This maps each `gsd-tools init` workflow that has a GSD command to the command
// stem whose skill runs it — most are the same name, a few differ (`resume` ->
// `resume-work`, `new-workspace` -> `workspace`, ...). tests/pi-workflow-handoff
// pins every target to a commands/gsd/<name>.md file and every `gsd-tools init`
// workflow to either an entry here or an explicit no-skill reason.
const PI_WORKFLOW_INIT_COMMANDS = Object.freeze({
  'execute-phase': 'execute-phase',
  'plan-phase': 'plan-phase',
  'new-project': 'new-project',
  'new-milestone': 'new-milestone',
  onboard: 'onboard',
  quick: 'quick',
  'quick-batch': 'quick-batch',
  'ingest-docs': 'ingest-docs',
  'verify-work': 'verify-work',
  'code-review': 'code-review',
  review: 'review',
  'map-codebase': 'map-codebase',
  progress: 'progress',
  manager: 'manager',
  'complete-milestone': 'complete-milestone',
  autonomous: 'autonomous',
  'docs-update': 'docs-update',
  update: 'update',
  debug: 'debug',
  resume: 'resume-work',
  'discuss-phase-assumptions': 'discuss-phase',
  'new-workspace': 'workspace',
});

// ── Pi package layout (#5558) ───────────────────────────────────────────────
// `pi install npm:@opengsd/gsd-core` loads THIS file straight out of the npm
// package (manifest `pi.extensions`). There, the engine tree is the package
// root and Pi's skills are not installed anywhere: they ship as templates under
// `pi/package-skills/` (generated by scripts/gen-pi-package-skills.cjs from the
// installer's own output, with the engine root replaced by a token) and are
// rendered with the real package location into a cache directory that
// `resources_discover` hands to Pi. The installer layout (`<cfg>/extensions/
// gsd.js` next to `<cfg>/gsd-core`) has no `pi/package-skills`, so it never
// enters this mode.
const PI_ENGINE_ROOT_TOKEN = '__GSD_PI_ENGINE_ROOT__';
// Characters a package location may contain for its text to be written into skills.
const SAFE_ENGINE_ROOT = /^[\p{L}\p{N}\p{M}._/:@+ ~()-]+$/u;

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** @param {string} engineRoot @returns {string} */
function packageSkillsDir(engineRoot) {
  return path.join(engineRoot, 'pi', 'package-skills');
}

/**
 * True when the extension runs out of the Pi package: the skill templates and
 * the engine entry point are both present under the engine root.
 * @param {string} [engineRoot]
 * @returns {boolean}
 */
function isPackageLayout(engineRoot = ENGINE_ROOT) {
  return isDirectory(packageSkillsDir(engineRoot))
    && isFile(path.join(engineRoot, 'gsd-core', 'bin', 'gsd-tools.cjs'));
}

/**
 * Pi's agent directory: `PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
function piAgentDir(env = process.env, home = os.homedir()) {
  const configured = env && typeof env.PI_CODING_AGENT_DIR === 'string' ? env.PI_CODING_AGENT_DIR : '';
  return configured ? path.resolve(configured) : path.join(home, '.pi', 'agent');
}

/**
 * Render the package's skill templates for `engineRoot` into
 * `<cacheRoot>/<key>/skills` and return that directory. `key` hashes the engine
 * root and every rendered body, so a moved package or a changed template gets
 * its own directory and a complete directory is reused. Written to a temp
 * directory and renamed into place, so a concurrent session never sees a
 * half-written tree. Throws on an fs failure; the caller degrades.
 * @param {string} engineRoot
 * @param {string} cacheRoot
 * @returns {string}
 */
function renderPackageSkills(engineRoot, cacheRoot) {
  const srcDir = packageSkillsDir(engineRoot);
  const names = fs.readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^gsd-[a-z0-9-]+$/.test(e.name))
    .map((e) => e.name)
    .sort();
  const root = engineRoot.replace(/\\/g, '/');
  // The root is substituted into shell double quotes (the workflow launcher
  // preamble) and into `@` include lines the model follows, so only a
  // conservative path alphabet is rendered; anything else fails open upstream.
  if (!SAFE_ENGINE_ROOT.test(root)) {
    throw new Error(`package location contains characters GSD will not write into skill text: ${JSON.stringify(root)}`);
  }
  const rendered = names.map((name) => [
    name,
    fs.readFileSync(path.join(srcDir, name, 'SKILL.md'), 'utf8').split(PI_ENGINE_ROOT_TOKEN).join(root),
  ]);
  const hash = crypto.createHash('sha256').update(`${root}\0`);
  for (const [name, body] of rendered) hash.update(`${name}\0${body}\0`);
  const key = hash.digest('hex').slice(0, 16);
  const finalDir = path.join(cacheRoot, key);
  const skillsDir = path.join(finalDir, 'skills');
  // A reused directory must hold exactly the rendered bodies as regular files
  // (not symlinks), so a planted or truncated cache entry is rewritten, not trusted.
  const complete = (dir) => rendered.every(([name, body]) => {
    try {
      const file = path.join(dir, name, 'SKILL.md');
      return fs.lstatSync(file).isFile() && fs.readFileSync(file, 'utf8') === body;
    } catch { return false; }
  });
  if (complete(skillsDir)) return skillsDir;

  fs.mkdirSync(cacheRoot, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(cacheRoot, '.tmp-'));
  try {
    for (const [name, body] of rendered) {
      fs.mkdirSync(path.join(tmpDir, 'skills', name), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'skills', name, 'SKILL.md'), body);
    }
    // Another session may have finished this very directory while ours was
    // being written: never delete a complete one out from under its reader.
    if (complete(skillsDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return skillsDir;
    }
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // A concurrent session may have completed the same directory first.
    if (complete(skillsDir)) return skillsDir;
    throw e;
  }
  pruneRenderCache(cacheRoot, key);
  return skillsDir;
}

// Rendered directories kept in the cache, the current one included. A new
// package version or a moved package adds one; older ones are removed oldest
// first, so the cache stays bounded without deleting what another running
// session of a recent version still reads.
const RENDER_CACHE_KEEP = 3;

/**
 * Remove stale rendered directories and abandoned temp directories. Best
 * effort: a failure here never affects the render that just succeeded.
 * @param {string} cacheRoot
 * @param {string} keepKey  the directory just rendered, never removed
 * @param {number} [keep]   how many `<hash>` directories to keep in total
 */
function pruneRenderCache(cacheRoot, keepKey, keep = RENDER_CACHE_KEEP) {
  try {
    const dirs = fs.readdirSync(cacheRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    const hashed = dirs
      .filter((e) => /^[0-9a-f]{16}$/.test(e.name) && e.name !== keepKey)
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(cacheRoot, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of hashed.slice(Math.max(0, keep - 1))) {
      fs.rmSync(path.join(cacheRoot, old.name), { recursive: true, force: true });
    }
    const hourAgo = Date.now() - 3600000;
    for (const e of dirs.filter((d) => d.name.startsWith('.tmp-'))) {
      const dir = path.join(cacheRoot, e.name);
      if (fs.statSync(dir).mtimeMs < hourAgo) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}

/**
 * Put the package's `gsd-core/bin` first on PATH so the workflow launcher's
 * identity-proving `gsd_run` fallback resolves without a per-runtime config home.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} engineRoot
 * @returns {boolean} true when PATH changed
 */
function activatePackageEnv(env, engineRoot) {
  const bin = path.join(engineRoot, 'gsd-core', 'bin');
  const parts = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  if (parts.includes(bin)) return false;
  env.PATH = [bin, ...parts].join(path.delimiter);
  return true;
}

/**
 * Whether the installer-layout extension is also installed, in which case the
 * package stands down: two copies would register `/gsd` and every `gsd-*` skill twice.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {boolean}
 */
function installerLayoutPresent(env = process.env, home = os.homedir()) {
  return isFile(path.join(piAgentDir(env, home), 'extensions', 'gsd.js'));
}

/**
 * Whether the installed tree carries `skills/gsd-<name>/SKILL.md`. Local to the
 * config dir the extension was installed into, so a data-only (pre-#5547) tree
 * or a partial install simply has no hand-off and keeps the data behavior.
 * @param {string} name  bare command stem, e.g. "new-project"
 * @param {string} [engineRoot]
 * @returns {boolean}
 */
function hasWorkflowSkill(name, engineRoot = ENGINE_ROOT) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) return false;
  try {
    // In the Pi package layout `<root>/skills` is the Claude plugin's skill
    // directory, not Pi's; the package's Pi skills are the rendered templates.
    const skillsDir = isPackageLayout(engineRoot)
      ? packageSkillsDir(engineRoot)
      : path.join(engineRoot, 'skills');
    return fs.statSync(path.join(skillsDir, `gsd-${name}`, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
}

/**
 * Decide whether `/gsd <family> ...` is a workflow command. The data families
 * (`init`, `state`, `phase`, ...) keep their scripted data semantics, so
 * `/gsd phase list` and `gsd_invoke` are unchanged; anything else that names an
 * installed `gsd-<name>` skill is handed off to it.
 * @param {string} rawArgs  the raw `/gsd` argument string
 * @param {string} [engineRoot]
 * @returns {{ skill: string, message: string } | null}
 */
function resolveWorkflowHandoff(rawArgs, engineRoot = ENGINE_ROOT) {
  const { family } = parseGsdCommandArgs(rawArgs);
  if (PI_COMMAND_FAMILIES.includes(family)) return null;
  if (!hasWorkflowSkill(family, engineRoot)) return null;
  // The remainder is forwarded verbatim (not re-joined from tokens) so quoting
  // the user typed survives into the skill's argument text.
  const trimmed = String(rawArgs || '').trim();
  const remainder = trimmed.slice(trimmed.indexOf(family) + family.length).trim();
  const skill = `gsd-${family}`;
  return { skill, message: remainder ? `/skill:${skill} ${remainder}` : `/skill:${skill}` };
}

/**
 * The next-step line appended to `/gsd init <workflow>` output. `init <workflow>`
 * is a data call the workflow itself makes, so it keeps returning its JSON; for
 * a human at the prompt that JSON is a dead end, so name the way to run the
 * workflow. Never added to `gsd_invoke`, whose output is parsed by callers.
 * @param {{ family: string, subcommand?: string, args?: string[] }} parsed  the tokenized
 *   `/gsd` call, as returned by parseGsdCommandArgs
 * @param {string} [engineRoot]
 * @returns {string} the line to append, or '' when none applies
 */
function nextStepFor({ family, subcommand, args: rest = [] }, engineRoot = ENGINE_ROOT) {
  if (family !== 'init' || typeof subcommand !== 'string') return '';
  if (!Object.prototype.hasOwnProperty.call(PI_WORKFLOW_INIT_COMMANDS, subcommand)) return '';
  const command = PI_WORKFLOW_INIT_COMMANDS[subcommand];
  if (!hasWorkflowSkill(command, engineRoot)) return '';
  // Positional arguments (a phase number, say) carry over; flags belong to the
  // init data call and are not guaranteed to mean anything to the workflow.
  const positional = (Array.isArray(rest) ? rest : []).filter((a) => typeof a === 'string' && !a.startsWith('-'));
  const tail = positional.length > 0 ? ` ${positional.join(' ')}` : '';
  return `\n\nNext: run /gsd ${command}${tail} (or /skill:gsd-${command}${tail}) to start the ${command} workflow — this output is only its init data.`;
}

// ── Agent-role dispatch (#5569, ADR-5559) ────────────────────────────────────
// Pi has no subagent primitive, so GSD supplies one: `gsd_dispatch` runs a `gsd-*` role in an
// isolated child `pi` process. Everything is fail-closed: every refusal is an error RESULT (never a
// throw, never an inline fallback that would run the role's work in the orchestrating session).
// The dispatcher lives in this file because the installer copies exactly one file
// (extensions/gsd.js); a sibling module would not be installed.
const DISPATCH = Object.freeze({
  ROLE_RE: /^gsd-[a-z0-9-]+$/,
  SAFE_VALUE_RE: /^[A-Za-z0-9_.:/@+][A-Za-z0-9_.:/@+,-]*$/,
  MAX_DEPTH: 1,
  TIMEOUT_MS: 30 * 60 * 1000,
  KILL_GRACE_MS: 5000,
  TASKKILL_TIMEOUT_MS: 10000,
  STDOUT_CAP: 1024 * 1024,
  MAX_LINE: 16 * 1024 * 1024,
  STDERR_TAIL: 8 * 1024,
  TRUNCATION_MARKER: '\n[GSD: dispatch output truncated at 1 MiB]',
  FAILED_STOP_REASONS: Object.freeze(['error', 'aborted', 'length']),
});

const dispatchFail = (code, message) => ({ ok: false, code, message });
const errorText = (e) => (e && e.message ? e.message : String(e));
/** A failed spawn: ENOENT means no runnable pi, anything else is a child failure. */
const spawnFailure = (e) => (e && e.code === 'ENOENT'
  ? dispatchFail('pi-not-found', 'No runnable `pi` was found on PATH.')
  : dispatchFail('child-failed', `Could not start pi: ${errorText(e)}`));

/** `key: value` pairs of a role file's leading frontmatter block (values unquoted, single line). */
function readRoleFrontmatter(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text));
  const meta = {};
  if (!block) return meta;
  for (const line of block[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return meta;
}

/**
 * Resolve a role id to its file in the install this extension belongs to. The role is matched against
 * a directory LISTING, never joined from the caller's string, so no input can name a path.
 * @returns {{ ok: true, file: string, meta: object } | { ok: false, code: string, message: string }}
 */
function resolveDispatchRole(role, extensionDir) {
  if (typeof role !== 'string' || !DISPATCH.ROLE_RE.test(role)) {
    return dispatchFail('role-unresolved', `"${String(role).slice(0, 80)}" is not a GSD role id (gsd-<name>).`);
  }
  // Installer layout: <config>/extensions/gsd.js beside <config>/agents and the install manifest.
  // Package layout (pi install npm:...): <package>/pi/gsd.cjs beside the converted roles and their
  // manifest, generated into the tarball (ADR-5559 amendment). Both are fixed relative to this file.
  const inPackage = fs.existsSync(path.join(extensionDir, 'package-agents'));
  const roleDir = inPackage ? path.join(extensionDir, 'package-agents') : path.join(extensionDir, '..', 'agents');
  const manifestPath = inPackage ? path.join(roleDir, 'manifest.json') : path.join(extensionDir, '..', 'gsd-file-manifest.json');
  const manifestKey = inPackage ? `${role}.md` : `agents/${role}.md`;
  const fileName = `${role}.md`;
  let listing;
  try { listing = fs.readdirSync(roleDir); } catch { listing = []; }
  if (!listing.includes(fileName)) {
    return dispatchFail('role-unresolved', `${role} is not installed (looked in ${roleDir}).`);
  }
  const file = path.join(roleDir, fileName);
  let bytes;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return dispatchFail('role-unresolved', `${fileName} is a symbolic link.`);
    bytes = fs.readFileSync(file);
  } catch (e) {
    return dispatchFail('role-unresolved', `${fileName} could not be read: ${errorText(e)}`);
  }
  // The manifest is required: without it nothing vouches for the bytes that become the child's system prompt.
  let expected;
  try { expected = (JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files || {})[manifestKey]; } catch { expected = undefined; }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (expected !== actual) {
    return dispatchFail('role-tampered', `${fileName} does not match the install manifest (or the manifest is missing); reinstall GSD to restore it.`);
  }
  // A package role is a template: its `@` references carry PI_ENGINE_ROOT_TOKEN for the package location.
  let text = bytes.toString('utf8');
  if (inPackage) {
    const root = path.resolve(extensionDir, '..').replace(/\\/g, '/');
    if (!SAFE_ENGINE_ROOT.test(root)) {
      return dispatchFail('role-unresolved', `the package location contains characters GSD will not write into a role: ${JSON.stringify(root)}`);
    }
    text = text.split(PI_ENGINE_ROOT_TOKEN).join(root);
  }
  return { ok: true, file, bytes: Buffer.from(text, 'utf8'), meta: readRoleFrontmatter(text) };
}

/** taskkill by absolute path: a bare name on Windows is searched in the spawn cwd (the project) first. */
function taskkillPath(env) {
  const root = (env && (env.SystemRoot || env.windir)) || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'taskkill.exe');
}

/**
 * The `pi` to run (ADR-5559 `pi-not-found`): the CLI next to this process's executable if there is
 * one, else the first `pi` on PATH. On Windows the PATH entries are searched here and an absolute
 * path is returned, so the project directory (the spawn cwd) is never searched for an executable.
 * @returns {string|null} null when no runnable pi was found on Windows
 */
function resolvePiCommand({ platform, env, execPath, exists }) {
  const win = platform === 'win32';
  const pathMod = win ? path.win32 : path.posix;
  // Windows: only pi.exe. A .cmd shim cannot be spawned without a shell (Node refuses it, CVE-2024-27980).
  const names = win ? ['pi.exe'] : ['pi'];
  for (const name of names) {
    const sibling = pathMod.join(pathMod.dirname(execPath || ''), name);
    if (execPath && exists(sibling)) return sibling;
  }
  if (!win) return 'pi';
  const dirs = String((env && (env.Path || env.PATH)) || '').split(';').filter((d) => /^[A-Za-z]:[\\/]/.test(d));
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = pathMod.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The dispatcher. Seams (all optional): `spawn`, `kill`, `env`, `platform`, `extensionDir`, `command`, `execPath`, `exists`.
 * Calls run strictly one at a time (ADR-5559 section 2).
 */
function createDispatcher(deps = {}) {
  const extensionDir = deps.extensionDir || __dirname;
  const spawn = deps.spawn || require('child_process').spawn;
  const killProcess = deps.kill || ((pid, signal) => process.kill(pid, signal));
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const isWindows = platform === 'win32';
  const timeoutMs = Number(env.GSD_PI_DISPATCH_TIMEOUT_MS) > 0 ? Number(env.GSD_PI_DISPATCH_TIMEOUT_MS) : DISPATCH.TIMEOUT_MS;
  let queue = Promise.resolve();

  function terminate(child) {
    if (isWindows) {
      const killer = spawn(taskkillPath(env), ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
      const bound = setTimeout(() => { if (killer && typeof killer.kill === 'function') { try { killer.kill(); } catch { /* gone */ } } }, DISPATCH.TASKKILL_TIMEOUT_MS);
      if (killer && typeof killer.once === 'function') killer.once('exit', () => clearTimeout(bound));
      return;
    }
    try { killProcess(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  }

  function runChild(child, signal, finishWith) {
    let timedOut = false;
    let closed = false;
    let escalate = null;
    let buffered = '';
    let last = null;
    let stderrTail = '';
    let overflow = false;

    const stop = () => {
      timedOut = true;
      terminate(child);
      if (!isWindows) {
        escalate = setTimeout(() => { if (!closed) { try { killProcess(-child.pid, 'SIGKILL'); } catch { /* gone */ } } }, DISPATCH.KILL_GRACE_MS);
      }
    };
    const deadline = setTimeout(stop, timeoutMs);
    const onAbort = () => stop();
    if (signal) {
      if (signal.aborted) stop(); else signal.addEventListener('abort', onAbort, { once: true });
    }

    const onLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event && event.type === 'message_end' && event.message && event.message.role === 'assistant') {
        const parts = Array.isArray(event.message.content) ? event.message.content : [];
        last = {
          text: parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join(''),
          stopReason: event.message.stopReason,
        };
      }
    };
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        onLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
      if (buffered.length > DISPATCH.MAX_LINE) { overflow = true; buffered = ''; stop(); }
    });
    child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-DISPATCH.STDERR_TAIL); });
    child.on('error', (e) => {
      closed = true;
      clearTimeout(deadline);
      clearTimeout(escalate);
      finishWith(spawnFailure(e));
    });
    child.on('close', (code) => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      clearTimeout(escalate);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (buffered) onLine(buffered);
      if (overflow) return finishWith(dispatchFail('child-failed', 'The role produced a single output line larger than 16 MiB.'));
      if (timedOut) return finishWith(dispatchFail('timeout', `The role did not finish within ${Math.round(timeoutMs / 1000)} s or was cancelled; it was stopped.`));
      if (code !== 0) return finishWith(dispatchFail('child-failed', `pi exited with code ${code}.${stderrTail ? ` stderr (tail): ${stderrTail}` : ''}`));
      if (!last) return finishWith(dispatchFail('child-failed', 'pi finished without an assistant message.'));
      if (DISPATCH.FAILED_STOP_REASONS.includes(last.stopReason)) {
        return finishWith(dispatchFail('child-failed', `The role's final message stopped with "${last.stopReason}".${stderrTail ? ` stderr (tail): ${stderrTail}` : ''}`));
      }
      const text = last.text.length > DISPATCH.STDOUT_CAP ? last.text.slice(0, DISPATCH.STDOUT_CAP) + DISPATCH.TRUNCATION_MARKER : last.text;
      return finishWith({ ok: true, text });
    });
  }

  function runOne(params, ctx) {
    const p = params && typeof params === 'object' ? params : {};
    // Unset or empty means top level; any other value must be a plain non-negative integer below the cap.
    const rawDepth = env.GSD_PI_DISPATCH_DEPTH;
    const depth = rawDepth === undefined || rawDepth === '' ? 0 : (/^\d{1,6}$/.test(rawDepth) ? Number(rawDepth) : Infinity);
    if (depth >= DISPATCH.MAX_DEPTH) {
      return Promise.resolve(dispatchFail('depth-exceeded', 'A dispatched role cannot dispatch another role (Pi dispatch is flat).'));
    }
    const resolved = resolveDispatchRole(p.role, extensionDir);
    if (!resolved.ok) return Promise.resolve(resolved);
    const roleTools = resolved.meta.tools ? resolved.meta.tools.split(',').map((s) => s.trim()).filter(Boolean).join(',') : '';
    const tools = roleTools || '-gsd_dispatch';
    if ((roleTools && !DISPATCH.SAFE_VALUE_RE.test(roleTools)) || (resolved.meta.model && !DISPATCH.SAFE_VALUE_RE.test(resolved.meta.model))) {
      return Promise.resolve(dispatchFail('role-unresolved', `${p.role} has a tools or model value that is not a plain identifier list.`));
    }
    let taskDir;
    try {
      taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pi-dispatch-'));
      fs.chmodSync(taskDir, 0o700);
    } catch (e) {
      return Promise.resolve(dispatchFail('child-failed', `Could not create a private task directory: ${errorText(e)}`));
    }
    const taskFile = path.join(taskDir, 'task.md');
    const cleanup = () => { try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch { /* best-effort */ } };
    // The child reads the role from a copy of the bytes that were just hash-verified, so a swap of
    // the installed file between the check and the child's start changes nothing.
    const roleCopy = path.join(taskDir, 'role.md');
    try {
      fs.writeFileSync(taskFile, typeof p.task === 'string' ? p.task : '', { mode: 0o600 });
      fs.writeFileSync(roleCopy, resolved.bytes, { mode: 0o600 });
    } catch (e) {
      cleanup();
      return Promise.resolve(dispatchFail('child-failed', `Could not write the task file: ${errorText(e)}`));
    }
    const args = [
      '--mode', 'json', '-p', '--no-session', '--no-mcp', '--no-extensions', '--no-approve',
      '--append-system-prompt', roleCopy,
      ...(resolved.meta.model ? ['--model', resolved.meta.model] : []),
      '--tools', tools,
      `@${taskFile}`,
    ];
    const childEnv = { ...env, GSD_PI_DISPATCH_DEPTH: String(depth + 1) };
    return new Promise((resolve) => {
      const finishWith = (result) => { cleanup(); resolve(result); };
      let child;
      try {
        const command = deps.command || resolvePiCommand({
          platform, env, execPath: deps.execPath || process.execPath, exists: deps.exists || ((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }),
        });
        if (command === null) {
          finishWith(dispatchFail('pi-not-found', 'No runnable `pi` was found on PATH.'));
          return;
        }
        child = spawn(command, args, {
          cwd: (ctx && ctx.cwd) || process.cwd(),
          env: childEnv,
          detached: !isWindows,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        finishWith(spawnFailure(e));
        return;
      }
      runChild(child, ctx && ctx.signal, finishWith);
    });
  }

  return {
    dispatch(params, ctx) {
      const run = queue.then(() => runOne(params, ctx));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

function buildGsdDispatchParameters() {
  try {
    const typebox = require('typebox');
    const Type = typebox && typebox.Type;
    if (Type) return Type.Object({ role: Type.String(), task: Type.String() });
  } catch { /* typebox is not a gsd-core dependency; the JSON-Schema fallback is the normal path */ }
  return { type: 'object', properties: { role: { type: 'string' }, task: { type: 'string' } }, required: ['role', 'task'] };
}

/**
 * @param {object} pi  pi ExtensionAPI
 * @param {{ env?: NodeJS.ProcessEnv, engineRoot?: string, home?: string }} [deps]  test seam; Pi passes only `pi`
 */
module.exports = function gsdPiExtension(pi, deps = {}) {
  if (!pi || typeof pi !== 'object') {
    throw new TypeError('gsdPiExtension: pi ExtensionAPI is required');
  }

  // ── Pi package mode (#5558) ──────────────────────────────────────────────
  const env = (deps && deps.env) || process.env;
  const engineRoot = (deps && deps.engineRoot) || ENGINE_ROOT;
  const home = (deps && deps.home) || os.homedir();
  let packageRenderError = null;
  let uiNotify = null;
  let renderErrorReported = false;
  // Pi may fire resources_discover before or after session_start; whichever
  // comes second reports the error, once.
  const reportRenderError = () => {
    if (!packageRenderError || renderErrorReported || !uiNotify) return;
    renderErrorReported = true;
    uiNotify(`GSD skills could not be prepared: ${packageRenderError.message}`, 'error');
  };
  if (isPackageLayout(engineRoot)) {
    if (installerLayoutPresent(env, home)) {
      // The installer copy of this extension is already loaded; registering the
      // package copy too would duplicate /gsd and every gsd-* skill.
      pi.on('session_start', async (event, ctx) => {
        if (ctx && ctx.ui && typeof ctx.ui.notify === 'function') {
          ctx.ui.notify(
            'GSD is installed both as a Pi package and by the gsd-core installer. The package copy is inactive; remove one of the two (pi remove npm:@opengsd/gsd-core, or the installer files under the Pi agent directory).',
            'warning',
          );
        }
      });
      return;
    }
    activatePackageEnv(env, engineRoot);
    pi.on('resources_discover', () => {
      try {
        return { skillPaths: [renderPackageSkills(engineRoot, path.join(piAgentDir(env, home), 'gsd-package-cache'))] };
      } catch (e) {
        packageRenderError = e;
        reportRenderError();
        return undefined; // fail-open: Pi still starts, without the GSD skills
      }
    });
  }

  // ── /gsd command: dispatch through gsd-tools.cjs (subprocess-reuse) ──────
  pi.registerCommand('gsd', {
    description: 'Invoke a GSD command via the embedded engine (subprocess-reuse adapter).',
    getArgumentCompletions,
    handler: async (args, ctx) => {
      const cwd = (ctx && ctx.cwd) || process.cwd();
      // #3456: Pi's command dispatcher awaits the handler and DISCARDS its
      // return value (agent-session.ts: `await command.handler(args, ctx);
      // return true;`) — #3097's `{ content: [...] }` return was silently
      // dropped exactly like the pre-#3097 bare string. The ONLY command-
      // output mechanism Pi consumes is `ctx.ui.notify(message, type)`
      // (pi docs: extensions.md#piregistercommandname-options), so the output
      // is pushed as a side effect on both the success and error paths.
      // Guarded so a host ctx without `ui` degrades silently instead of
      // crashing the command.
      const notify = (ctx && ctx.ui && typeof ctx.ui.notify === 'function')
        ? (message, type) => ctx.ui.notify(message, type)
        : null;
      // #5547: a workflow-backed command starts its workflow instead of
      // printing data. `sendUserMessage` with `expandPromptTemplates` makes Pi
      // expand the `/skill:` command, so the agent follows the installed skill.
      const handoff = resolveWorkflowHandoff(args, engineRoot);
      if (handoff && packageRenderError) {
        // The skill was never registered with Pi, so handing off would only
        // produce an unknown-skill message. Say why instead.
        if (notify) {
          notify(`${handoff.skill} is unavailable: GSD skills could not be prepared (${packageRenderError.message}).`, 'error');
        }
        return;
      }
      if (handoff) {
        if (typeof pi.sendUserMessage === 'function') {
          pi.sendUserMessage(handoff.message, { deliverAs: 'followUp', expandPromptTemplates: true });
        } else if (notify) {
          // A host without sendUserMessage cannot be handed off to; say how to
          // start the workflow by hand rather than running its data command.
          notify(`This pi host cannot start a skill from /gsd. Run ${handoff.message} to start the ${handoff.skill} workflow.`, 'info');
        }
        return;
      }
      const { family, subcommand, args: rest } = parseGsdCommandArgs(args);
      let dispatchGsdCommand;
      try {
        ({ dispatchGsdCommand } = require(path.join(GSD_CORE, 'bin', 'lib', 'shell-command-projection.cjs')));
      } catch (e) {
        if (notify) {
          notify(`GSD engine unavailable: ${e && e.message ? e.message : String(e)}`, 'error');
        }
        return;
      }
      const result = dispatchGsdCommand({ family, subcommand, args: rest, cwd });
      const text = result.ok
        ? `${result.stdout}${nextStepFor({ family, subcommand, args: rest }, engineRoot)}`
        : `GSD error: ${result.stderr || result.stdout || `dispatch failed (exit ${result.code})`}`;
      if (notify) {
        notify(text, result.ok ? 'info' : 'error');
      }
    },
  });

  // ── gsd_invoke tool: programmatic command invocation ────────────────────
  pi.registerTool({
    name: 'gsd_invoke',
    label: 'GSD Invoke',
    description: 'Invoke a GSD command family/subcommand through the engine.',
    parameters: buildGsdInvokeParameters(),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const p = (params && typeof params === 'object') ? params : {};
      const family = typeof p.family === 'string' ? p.family : '';
      if (!family) {
        return { content: [{ type: 'text', text: 'gsd_invoke requires a non-empty string "family".' }] };
      }
      const subcommand = typeof p.subcommand === 'string' ? p.subcommand : undefined;
      const invokeArgs = Array.isArray(p.args) ? p.args : [];
      const cwd = (ctx && ctx.cwd) || process.cwd();
      let dispatchGsdCommand;
      try {
        ({ dispatchGsdCommand } = require(path.join(GSD_CORE, 'bin', 'lib', 'shell-command-projection.cjs')));
      } catch (e) {
        return { content: [{ type: 'text', text: `GSD engine unavailable: ${e && e.message ? e.message : String(e)}` }] };
      }
      const result = dispatchGsdCommand({ family, subcommand, args: invokeArgs, cwd });
      const text = result.ok ? result.stdout : (result.stderr || result.stdout || `dispatch failed (exit ${result.code})`);
      return { content: [{ type: 'text', text }] };
    },
  });

  // ── gsd_dispatch tool: run a gsd-* role in an isolated child pi (#5569, ADR-5559) ──
  const dispatcher = createDispatcher({ extensionDir: __dirname, env });
  pi.registerTool({
    name: 'gsd_dispatch',
    label: 'GSD Dispatch',
    description: 'Run a GSD agent role (gsd-*) on a task in an isolated child Pi process and return its final message. Dispatch is flat and sequential; a role cannot dispatch another role.',
    parameters: buildGsdDispatchParameters(),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const result = await dispatcher.dispatch(params, { cwd: (ctx && ctx.cwd) || process.cwd(), signal });
      if (result.ok) return { content: [{ type: 'text', text: result.text }] };
      return { content: [{ type: 'text', text: `gsd_dispatch ${result.code}: ${result.message}` }], isError: true };
    },
  });

  // ── before_provider_request: active-model steering (modelMode: 'active') ──
  // GSD steers pi's EXISTING built-in anthropic models; it does NOT call
  // pi.registerProvider (that would wrongly register a NEW fake provider —
  // see buildBeforeProviderRequestHandler's doc comment).
  pi.on('before_provider_request', buildBeforeProviderRequestHandler());

  // ── Event bindings: bounded subprocess bridge to GSD's hook scripts ──────
  // Each binding fails open — a hook error/timeout/missing-file never blocks
  // pi (mirrors .opencode/plugins/gsd-core.js's runHook SUBPROCESS-REUSE
  // pattern, applied to pi's ExtensionAPI event names).

  // session_start → SessionStart-equivalent bootstrap.
  pi.on('session_start', async (event, ctx) => {
    try {
      if (ctx && ctx.ui && typeof ctx.ui.notify === 'function') {
        uiNotify = (message, type) => ctx.ui.notify(message, type);
        reportRenderError();
      }
      const cwd = (ctx && ctx.cwd) || process.cwd();
      runHook('gsd-ensure-canonical-path.js', { hook_event_name: 'SessionStart', cwd }, { cwd });
    } catch { /* fail-open */ }
  });

  // before_agent_start → workflow-guard bridge. Forward-compatible binding:
  // gsd-workflow-guard.js's current triggers are tool-scoped (Write/Edit/
  // Bash via tool_name/tool_input), so with no tool_name in the payload it
  // fires as a safe no-op today — wired so a future agent-start-scoped check
  // can attach without a plugin change (mirrors the OpenCode session.idle
  // recognized-but-unused sentinel pattern).
  pi.on('before_agent_start', async (event, ctx) => {
    try {
      const cwd = (ctx && ctx.cwd) || process.cwd();
      runHook('gsd-workflow-guard.js', { hook_event_name: 'before_agent_start', cwd }, { cwd });
    } catch { /* fail-open */ }
  });

  // session_before_compact → PreCompact-equivalent (context-usage bridge).
  pi.on('session_before_compact', async (event, ctx) => {
    try {
      const cwd = (ctx && ctx.cwd) || process.cwd();
      runHook('gsd-context-monitor.js', { hook_event_name: 'PreCompact', cwd }, { cwd });
    } catch { /* fail-open */ }
  });

  // tool_call event: lifecycle hook bridge attachment point (kept from the
  // original cut — the PreToolUse/PostToolUse tool_name/tool_input mapping
  // is a follow-up once pi's tool_call payload shape is verified against a
  // live host).
  pi.on('tool_call', async function () {
    /* GSD hook bridge attachment point (PreToolUse/PostToolUse mapping). */
  });
};

// Test-only internals (mirrors the OpenCode plugin pattern) — wired to the
// real functions (not stubs) so tests can exercise parsing/completions/model
// resolution WITHOUT a live pi runtime.
module.exports._internals = {
  resolveEngineRoot,
  resolveSharedHooksDir,
  SHARED_HOOKS_DIR_CANDIDATES,
  parseGsdCommandArgs,
  getArgumentCompletions,
  PI_COMMAND_FAMILIES,
  buildBeforeProviderRequestHandler,
  buildGsdInvokeParameters,
  runHook,
  hasWorkflowSkill,
  PI_ENGINE_ROOT_TOKEN,
  isPackageLayout,
  packageSkillsDir,
  piAgentDir,
  renderPackageSkills,
  pruneRenderCache,
  RENDER_CACHE_KEEP,
  activatePackageEnv,
  installerLayoutPresent,
  resolveWorkflowHandoff,
  nextStepFor,
  PI_WORKFLOW_INIT_COMMANDS,
  DISPATCH,
  createDispatcher,
  resolveDispatchRole,
  readRoleFrontmatter,
  resolvePiCommand,
  taskkillPath,
  buildGsdDispatchParameters,
};
