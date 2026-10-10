'use strict';

/**
 * Runtime Hooks Surface Module — hook-surface writer functions extracted from
 * bin/install.js (ADR-857 phase 5f-1).
 *
 * Owns the lifecycle writer functions for hook surfaces managed by GSD on four
 * runtimes:
 *   Cline:   writeClineArtifacts + supporting helpers/constants
 *   Cursor:  buildCursorHookEntry, isManagedCursorHookEntry,
 *            reconcileCursorHooksJson, writeCursorHooksJson, removeCursorHooksJson
 *   Copilot: buildCopilotHookConfig, writeCopilotHookConfig
 *   Codex hooks.json: ensureCodexHooksJsonSessionStart, ensureCodexHooksJsonEvent,
 *            reconcileCodexHooksJsonEvent, reconcileCodexHooksJsonSessionStart,
 *            removeCodexHooksJsonEvent, removeCodexHooksJsonSessionStart,
 *            buildCodexHookWindowsShimIR, buildCodexHookBlock, rewriteLegacyCodexHookBlock
 *   Shared:  buildHookCommand, rewriteLegacyManagedNodeHookCommands
 *
 * BEHAVIOR-PRESERVING RELOCATION: all logic is copied verbatim from
 * bin/install.js. No behavior change, no descriptor reads, no new IO.
 *
 * #2876 (epic #2866 Phase 7): bin/install.js previously re-exported every
 * symbol from this module, but a repo-wide audit found zero production
 * consumers of those re-exports — no `require('../bin/install.js').
 * writeCursorHooksJson` (or any sibling) exists outside a doc comment
 * anywhere in the tree. The re-exports were test-suite-only pass-throughs;
 * tests now require this module directly instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// #2544: the single source of truth for the CommonJS module-type marker. The
// two helpers below are thin boolean-returning shims over these — see the
// marker section for why this file no longer carries its own copy.
import {
  ensureCommonJsMarker as ensureCommonJsMarkerOwned,
  removeCommonJsMarker as removeCommonJsMarkerOwned,
} from './commonjs-marker.cjs';
import {
  CURSOR_HOOK_EVENTS,
  CURSOR_EVENT_SCRIPT_MAP,
  resolveManagedHookEvents,
  resolveHookScripts,
  buildHookBusEntries,
} from './host-integration-adapters/imperative-hook-bus.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import shellCmdProjection = require('./shell-command-projection.cjs');
const {
  isManagedHookBasename,
  isManagedHookCommand,
  projectLegacySettingsHookCommand,
  projectManagedHookCommand,
  projectPortableHookBaseDir,
  projectCodexHookTomlCommand,
  shellHookOmitsBashRunner,
  escapeTomlDoubleQuotedString,
  escapePosixDoubleQuoted,
  resolveExecutableBinary,
} = shellCmdProjection as {
  isManagedHookBasename: (scriptPath: string, opts?: { surface?: string }) => boolean;
  isManagedHookCommand: (cmd: string | null | undefined, opts?: { surface?: string; includeLegacyAliases?: boolean; configDir?: string }) => boolean;
  projectLegacySettingsHookCommand: (opts: { runnerToken: string; scriptPath: string; scriptToken: string; runtime: string; platform: string }) => string | null;
  projectManagedHookCommand: (opts: { absoluteRunner: string; scriptPath: string; runtime: string; platform: string; hookShell?: string }) => string | null;
  projectPortableHookBaseDir: (opts: { configDir: string; homeDir: string }) => string;
  projectCodexHookTomlCommand: (opts: { absoluteRunner: string; scriptPath: string; platform: string }) => string;
  shellHookOmitsBashRunner: (opts: { platform: string; runtime: string; isShellHook: boolean }) => boolean;
  escapeTomlDoubleQuotedString: (value: unknown) => string;
  escapePosixDoubleQuoted: (value: unknown) => string;
  resolveExecutableBinary: (name: string, opts?: { platform?: string; requireExecutable?: boolean }) => string | null;
};

// ---------------------------------------------------------------------------
// Terminal color constants (mirrors install.js for console output parity)
// ---------------------------------------------------------------------------
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const reset = '\x1b[0m';

// ---------------------------------------------------------------------------
// Codex config.toml constants (subset needed by this module)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Copilot hook constants
// ---------------------------------------------------------------------------
const GSD_COPILOT_HOOK_FILE = 'gsd-session.json';
const GSD_COPILOT_SESSION_MSG_PRESENT =
  'GSD: .planning/STATE.md present - review the current phase and any blockers before acting.';
const GSD_COPILOT_SESSION_MSG_ABSENT =
  'GSD: no .planning/ workflow found - run /gsd-new-project to start a tracked workflow.';
const GSD_COPILOT_SESSION_HOOK_BASH =
  'if [ -f .planning/STATE.md ]; then ' +
  `printf '%s' '{"additionalContext":"${GSD_COPILOT_SESSION_MSG_PRESENT}"}'; else ` +
  `printf '%s' '{"additionalContext":"${GSD_COPILOT_SESSION_MSG_ABSENT}"}'; fi`;
const GSD_COPILOT_SESSION_HOOK_PWSH =
  'if (Test-Path .planning/STATE.md) ' +
  `{ '{"additionalContext":"${GSD_COPILOT_SESSION_MSG_PRESENT}"}' } ` +
  `else { '{"additionalContext":"${GSD_COPILOT_SESSION_MSG_ABSENT}"}' }`;

// #2099 UPGRADE 1: multi-event hook bus. Each additional event is a static,
// deterministic advisory (no branching/no-op-style, matching sessionStart's
// tone) so the emitted hooks/gsd-session.json stays golden-trackable — no
// node-runner invocation, no filesystem probing beyond what sessionStart
// already does.
const GSD_COPILOT_PRE_TOOL_MSG =
  'GSD: confirm this tool use is in scope for the active phase before proceeding.';
const GSD_COPILOT_PRE_TOOL_HOOK_BASH =
  `printf '%s' '{"additionalContext":"${GSD_COPILOT_PRE_TOOL_MSG}"}'`;
const GSD_COPILOT_PRE_TOOL_HOOK_PWSH =
  `'{"additionalContext":"${GSD_COPILOT_PRE_TOOL_MSG}"}'`;

const GSD_COPILOT_POST_TOOL_MSG =
  'GSD: review the tool result against the active phase before continuing.';
const GSD_COPILOT_POST_TOOL_HOOK_BASH =
  `printf '%s' '{"additionalContext":"${GSD_COPILOT_POST_TOOL_MSG}"}'`;
const GSD_COPILOT_POST_TOOL_HOOK_PWSH =
  `'{"additionalContext":"${GSD_COPILOT_POST_TOOL_MSG}"}'`;

const GSD_COPILOT_PROMPT_SUBMIT_MSG =
  'GSD: check this request against .planning/STATE.md scope before acting.';
const GSD_COPILOT_PROMPT_SUBMIT_HOOK_BASH =
  `printf '%s' '{"additionalContext":"${GSD_COPILOT_PROMPT_SUBMIT_MSG}"}'`;
const GSD_COPILOT_PROMPT_SUBMIT_HOOK_PWSH =
  `'{"additionalContext":"${GSD_COPILOT_PROMPT_SUBMIT_MSG}"}'`;

const GSD_COPILOT_SESSION_END_MSG =
  'GSD: update .planning/STATE.md with the session outcome before ending.';
const GSD_COPILOT_SESSION_END_HOOK_BASH =
  `printf '%s' '{"additionalContext":"${GSD_COPILOT_SESSION_END_MSG}"}'`;
const GSD_COPILOT_SESSION_END_HOOK_PWSH =
  `'{"additionalContext":"${GSD_COPILOT_SESSION_END_MSG}"}'`;

// ---------------------------------------------------------------------------
// Cursor hook constants
// ---------------------------------------------------------------------------
const GSD_CURSOR_SESSION_HOOK_SCRIPT = 'gsd-cursor-session-start.js';
const GSD_CURSOR_POST_TOOL_HOOK_SCRIPT = 'gsd-cursor-post-tool.js';
const GSD_CURSOR_PRE_TOOL_HOOK_SCRIPT = 'gsd-cursor-pre-tool.js';
const GSD_CURSOR_STOP_HOOK_SCRIPT = 'gsd-cursor-stop.js';
const GSD_CURSOR_SUBAGENT_START_HOOK_SCRIPT = 'gsd-cursor-subagent-start.js';
const GSD_CURSOR_SUBAGENT_STOP_HOOK_SCRIPT = 'gsd-cursor-subagent-stop.js';
const GSD_CURSOR_HOOK_MARKER = 'gsd-managed';

// The full set of Cursor hook events GSD manages — sourced from the adapter
// (src/host-integration-adapters/imperative-hook-bus.cts) so the vocabulary
// stays closed and first-party. Used by reconcileCursorHooksJson (the
// reconciliation scope is always the full set). The install path
// (writeCursorHooksJson) resolves a descriptor-driven subset via
// resolveManagedHookEvents(opts.managedHookEvents).
const CURSOR_MANAGED_EVENTS = CURSOR_HOOK_EVENTS;

// ---------------------------------------------------------------------------
// Cline / AGENTS.md constants
// ---------------------------------------------------------------------------
const GSD_AGENTS_MD_MARKER = '<!-- GSD Configuration — managed by gsd-core installer -->';
const GSD_AGENTS_MD_CLOSE_MARKER = '<!-- End GSD Configuration -->';

// ---------------------------------------------------------------------------
// Descriptor-driven runtime title lookup (ADR-1239 / #2092)
// ---------------------------------------------------------------------------

/**
 * Console-log label for a runtime, sourced from the capability registry's
 * `title` field (capabilities/<runtime>/capability.json). Folded from a
 * hardcoded `runtime === 'qwen' ? 'Qwen Code' : runtime === 'claude' ?
 * 'Claude Code' : runtime` ternary — cosmetic (log text) only, but resolves
 * to the same 'Qwen Code' / 'Claude Code' values for those two runtimes.
 * Falls back to the raw runtime id if the registry can't be loaded or the
 * runtime has no title.
 */
function _capabilityTitle(runtime: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reg = require('./capability-registry.cjs') as {
      runtimes?: Record<string, { title?: string } | undefined>;
    };
    return reg?.runtimes?.[runtime]?.title || runtime;
  } catch {
    return runtime;
  }
}

// ---------------------------------------------------------------------------
// atomicWriteFileSync — shared canonical implementation.
//
// __atomicWrittenTmps is exported so bin/install.js can merge it into its
// _cleanTmpFiles() scan, ensuring that atomic writes performed by this
// module (Cursor hooks.json, Codex hooks.json shims) participate in the
// same temp-file cleanup as writes performed directly by install.js.
//
// Every temp path written is recorded in the Set so _cleanTmpFiles() can
// scope cleanup to files this installer process actually created, avoiding
// accidental deletion of unrelated tools' temp files.
// ---------------------------------------------------------------------------
let __atomicWriteCounter = 0;
// Set<string> — absolute paths of .tmp-<pid>-<n> files this process created.
const __atomicWrittenTmps: Set<string> = new Set();
// Retry budget for the EEXIST (squatted temp path) branch in atomicWriteFileSync.
const MAX_TEMP_FILE_ATTEMPTS = 4;

function atomicWriteFileSync(target: string, data: string, options: fs.WriteFileOptions): void {
  // A pre-existing target's permission bits must survive the rewrite:
  // rename() swaps the temp file's inode into place, so without an explicit
  // carry a user-hardened chmod (e.g. 600 on a secrets-bearing settings.json)
  // would silently reset to the umask default.
  let priorMode: number | undefined;
  try {
    const st = fs.statSync(target);
    if (st.isFile()) priorMode = st.mode & 0o7777;
  } catch { /* no pre-existing target: default creation mode applies */ }

  // 'wx' (O_EXCL) refuses to follow a symlink pre-planted at the predictable
  // temp path and refuses to reuse a foreign file already sitting there; on
  // EEXIST the write retries under a fresh counter value.
  const exclusiveOptions: fs.WriteFileOptions =
    typeof options === 'string' || options == null
      ? { encoding: options ?? null, flag: 'wx' }
      : { ...options, flag: 'wx' };

  for (let attempt = 0; ; attempt++) {
    __atomicWriteCounter += 1;
    const tmp = `${target}.tmp-${process.pid}-${__atomicWriteCounter}`;
    __atomicWrittenTmps.add(tmp);
    try {
      fs.writeFileSync(tmp, data, exclusiveOptions);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        // The file at tmp is not ours — never rmSync it.
        if (attempt < MAX_TEMP_FILE_ATTEMPTS) continue;
        throw e;
      }
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw e;
    }
    try {
      // chmod rather than options.mode: open(2) masks mode with the process
      // umask, chmod applies the preserved bits exactly.
      if (priorMode !== undefined) fs.chmodSync(tmp, priorMode);
      shellCmdProjection.retryRenameSync(tmp, target);
      // Successful rename: the tmp path no longer exists, but leave it in the
      // Set so _cleanTmpFiles can recognise it as installer-owned if it somehow
      // lingers (e.g. a rename succeeded but left a stale entry on some FS).
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw e;
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// CommonJS package.json marker for staged .js hook scripts (#2717)
//
// Node resolves the nearest package.json walking up from a .js file. When a
// runtime's config root (e.g. ~/.cursor, ~/.codeium/windsurf, ~/.codex) — or any
// parent — declares {"type":"module"}, Node loads GSD's staged CommonJS hook
// scripts as ESM and every require() fails with "require is not defined",
// silently disabling that runtime's lifecycle hooks.
//
// installSharedHooksBundle writes this marker for the 12 runtimes that go
// through the shared hooks bundle, but cursor/windsurf (skipSharedHooksInstall)
// and codex (the !isCodex gate) stage their .js hooks via the dedicated paths
// below and never reached it. These helpers decouple the marker write from the
// shared bundle so any code path that stages .js hooks can ensure the marker
// lands in the SAME directory as the scripts (#2717).
//
// The marker content is byte-identical to installSharedHooksBundle's
// (bin/install.js installSharedHooksBundle): {"type":"commonjs"}\n.
//
// #2544: the two helpers below no longer carry their own copy of the write and
// remove rules — they DELEGATE to src/commonjs-marker.cts, which #2544 makes the
// single place both rules are enforced. Keeping a second copy here was not
// merely redundant; the copies had drifted apart on exactly the two properties
// that matter:
//
//   - ownership probe: `fs.existsSync` FOLLOWS symlinks and reports `false` for
//     a DANGLING one, so a dangling `package.json` symlink classified as absent
//     and the write below followed the link outside the directory GSD owns.
//     `classifyMarker` uses `lstat` + `isFile()`, so a symlink or a directory at
//     the marker path is classified `foreign` and left strictly alone.
//   - create: a plain `writeFileSync` leaves the classify->write window open.
//     `ensureCommonJsMarker` creates with `flag: 'wx'` (O_EXCL), so anything
//     that appears at the path in between fails with EEXIST instead of being
//     followed or overwritten.
//
// The exported signatures are unchanged (both still return a boolean), so every
// caller and the #2717 tests are unaffected.
// ---------------------------------------------------------------------------

/**
 * Ensure a `package.json` forcing CommonJS mode exists in `dir` (the directory
 * holding GSD-staged `.js` hook scripts). Idempotent: a no-op if the marker is
 * already present with GSD's content. Never clobbers a distinct user-authored
 * package.json (it leaves such a file in place; the user owns it).
 *
 * @param dir - absolute path to the directory holding the staged .js hooks
 * @returns `true` if GSD's marker is present after the call (written or already there)
 */
function ensureCommonJsMarker(dir: string): boolean {
  // 'written' | 'unchanged' -> the marker is ours and present.
  // 'preserved-foreign'     -> a file GSD does not own is there; left untouched.
  // 'failed'                -> environmental (EACCES/EROFS/ENOSPC); best-effort.
  const outcome = ensureCommonJsMarkerOwned(dir);
  return outcome === 'written' || outcome === 'unchanged';
}

/**
 * Remove the CommonJS marker from `dir` on uninstall — but ONLY if it carries
 * GSD's exact marker content. A user-authored package.json is never deleted.
 *
 * @param dir - absolute path to the directory that held the staged .js hooks
 * @returns `true` if a GSD-owned marker was removed
 */
function removeCommonJsMarkerIfGsdOwned(dir: string): boolean {
  return removeCommonJsMarkerOwned(dir);
}

// ---------------------------------------------------------------------------
// parseTomlValue + findMultilineBasicStringClose
// (needed by rewriteLegacyCodexHookBlock — pure TOML helpers, no state)
// ---------------------------------------------------------------------------

function findMultilineBasicStringClose(line: string, startIndex: number): number {
  let i = startIndex;
  while (i < line.length) {
    if (line.startsWith('"""', i) && (i === 0 || line[i - 1] !== '\\')) {
      return i;
    }
    i += 1;
  }
  return -1;
}

function parseTomlValue(text: string, i: number): { value: unknown; end: number } {
  // Skip leading whitespace.
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i += 1;
  }
  if (i >= text.length) {
    throw new Error('expected value, got end of input');
  }

  const ch = text[i];

  // Basic string
  if (ch === '"') {
    if (text.startsWith('"""', i)) {
      const close = findMultilineBasicStringClose(text, i + 3);
      if (close === -1) {
        throw new Error('unterminated multi-line basic string');
      }
      const raw = text.slice(i + 3, close);
      return { value: raw.replace(/^\r?\n/, ''), end: close + 3 };
    }
    let j = i + 1;
    let out = '';
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') {
        const next = text[j + 1];
        if (next === 'n') { out += '\n'; j += 2; continue; }
        if (next === 't') { out += '\t'; j += 2; continue; }
        if (next === 'r') { out += '\r'; j += 2; continue; }
        if (next === '\\') { out += '\\'; j += 2; continue; }
        if (next === '"') { out += '"'; j += 2; continue; }
        if (next === '/') { out += '/'; j += 2; continue; }
        out += next === undefined ? '' : next;
        j += 2;
        continue;
      }
      if (c === '"') {
        return { value: out, end: j + 1 };
      }
      out += c;
      j += 1;
    }
    throw new Error('unterminated basic string');
  }

  // Literal string
  if (ch === '\'') {
    if (text.startsWith("'''", i)) {
      const close = text.indexOf("'''", i + 3);
      if (close === -1) throw new Error('unterminated multi-line literal string');
      return { value: text.slice(i + 3, close).replace(/^\r?\n/, ''), end: close + 3 };
    }
    const close = text.indexOf('\'', i + 1);
    if (close === -1) throw new Error('unterminated literal string');
    return { value: text.slice(i + 1, close), end: close + 1 };
  }

  // Boolean
  if (text.startsWith('true', i)) return { value: true, end: i + 4 };
  if (text.startsWith('false', i)) return { value: false, end: i + 5 };

  // Number (integer or float, simplified)
  const numMatch = text.slice(i).match(/^[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?|inf|nan)/);
  if (numMatch) {
    const raw = numMatch[0];
    const cleaned = raw.replace(/_/g, '');
    const num = Number(cleaned);
    return { value: isNaN(num) ? cleaned : num, end: i + raw.length };
  }

  // Datetime (simplified passthrough)
  const dtMatch = text.slice(i).match(/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/);
  if (dtMatch) {
    return { value: dtMatch[0], end: i + dtMatch[0].length };
  }

  throw new Error(`parseTomlValue: unexpected character '${ch}' at position ${i}`);
}

// ---------------------------------------------------------------------------
// normalizeNodePath / resolveNodeRunner / resolveBashRunner
// (needed by buildHookCommand — verbatim from install.js)
// ---------------------------------------------------------------------------

interface NodeNormOpts {
  env?: NodeJS.ProcessEnv;
  existsSync?: (p: string) => boolean;
  /**
   * #3662: the process path to normalize instead of `process.execPath`.
   * Production callers omit it; tests use it to simulate an install baked by
   * a different environment (a foreign absolute node path).
   */
  execPath?: string;
}

/**
 * Normalize a directory that will be joined with `/…` — posix separators, no
 * trailing slash. `FNM_DIR=/custom/fnm/` would otherwise bake
 * `/custom/fnm//aliases/default/bin/node` (#3704 review). Cosmetic — `existsSync`
 * resolves the doubled separator and every shell collapses it — but the value is
 * written into a user's settings.json and read by humans.
 *
 * Shared by both fnm branches deliberately: they build the same alias paths from
 * different roots, and a trim applied to only one is a difference with no reason
 * behind it.
 */
function normalizeRootDir(dir: string): string {
  return shellCmdProjection.posixNormalize(dir).replace(/\/+$/, '');
}

function normalizeNodePath(execPath: string, opts?: NodeNormOpts): string {
  if (!execPath) return execPath;
  const env = (opts && opts.env) || process.env;
  const existsSync = (opts && opts.existsSync) || fs.existsSync;

  const normalizedForMatch = shellCmdProjection.posixNormalize(execPath);
  // #977: fnm's Windows shim IS `process.execPath` there — Windows does not
  // realpath through it — so this branch stays. #3704 adds `(?:bin\/)?`: fnm's
  // POSIX shim is `<multishell>/bin/node`, so the original pattern could not match
  // it even when a caller hands one in explicitly (#3662's `execPath` option
  // exists to do exactly that, normalizing a path from another environment).
  if (/\/fnm_multishells\/[0-9]+_[0-9]+\/(?:bin\/)?node(\.exe)?$/i.test(normalizedForMatch)) {
    const candidates: string[] = [];
    if (env.FNM_DIR) {
      const fnmRoot = normalizeRootDir(env.FNM_DIR);
      candidates.push(`${fnmRoot}/aliases/default/node.exe`);
      candidates.push(`${fnmRoot}/aliases/default/bin/node`);
    }
    const appdata = shellCmdProjection.envGet(env, 'APPDATA');
    if (appdata) {
      candidates.push(`${normalizeRootDir(appdata)}/fnm/aliases/default/node.exe`);
    }
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) return candidate;
    }
    return execPath;
  }

  // #3704: fnm pins a concrete version at
  // <FNM_DIR>/node-versions/<ver>/installation/bin/node (Windows:
  // .../installation/node.exe). On macOS/Linux this — not the shim above — is what
  // `process.execPath` reports, because Node realpaths through
  // `fnm_multishells`. So the shim branch above is unreachable on POSIX and the
  // raw versioned path was baked into every managed hook: `fnm uninstall <ver>`,
  // or fnm's own pruning, then 404s every hook — the ephemeral-path failure #977
  // exists to prevent, and the same one #1619 (mise) and #2185 (Homebrew) fixed
  // for their managers by matching the VERSIONED path rather than a shim.
  //
  // The stable alias is <FNM_DIR>/aliases/default/..., which fnm repoints on
  // `fnm default`. Derive <FNM_DIR> from execPath first (#2185's rule — the path
  // IS the install location, and FNM_DIR may be unset or point at a different
  // install), keeping the env as a secondary candidate. Rewrite only when the
  // alias exists; otherwise fall through to the raw execPath, exactly like the
  // mise and volta branches, so a rewrite never turns a stale-but-working pin
  // into an immediately broken one.
  const fnmVersioned = normalizedForMatch.match(
    /^(.*)\/node-versions\/[^/]+\/installation\/(?:bin\/)?node(\.exe)?$/i,
  );
  if (fnmVersioned) {
    const isExe = Boolean(fnmVersioned[2]);
    const roots = [fnmVersioned[1]];
    if (env.FNM_DIR) roots.push(normalizeRootDir(env.FNM_DIR));
    const fnmAliasCandidates: string[] = [];
    for (const root of roots) {
      // Probe the spelling matching the input first, then the other — a layout
      // is one or the other, and guessing wrong would skip a real alias.
      const leaf = isExe ? ['node.exe', 'bin/node'] : ['bin/node', 'node.exe'];
      for (const tail of leaf) fnmAliasCandidates.push(`${root}/aliases/default/${tail}`);
    }
    for (const candidate of fnmAliasCandidates) {
      if (existsSync(candidate)) return candidate;
    }
  }

  // Homebrew (macOS Intel /usr/local, Apple Silicon /opt/homebrew, Linuxbrew
  // /home/linuxbrew/.linuxbrew, and any custom HOMEBREW_PREFIX) pins node at
  // <prefix>/Cellar/node(<@ver>)?/<ver>/bin/node, then deletes prior versions on
  // `brew upgrade node`. Rewrite to the stable <prefix>/bin/node symlink, which
  // survives the upgrade. Derive <prefix> from the path itself (more reliable
  // than HOMEBREW_PREFIX env — the path IS the install location) so every layout
  // is covered by one branch instead of one per known prefix (#2185).
  //
  // #4137: rewrite only when the symlink exists; otherwise fall through to the
  // raw execPath, exactly like the mise and volta branches. A keg-only/versioned
  // formula (node@24 installed but never `brew link`ed) has no <prefix>/bin/node
  // at all, so the unconditional rewrite handed every managed hook a path that
  // fails at invocation — a rewrite must never turn a working keg path into an
  // immediately broken one.
  const homebrewMatch = normalizedForMatch.match(
    /^(.+)\/Cellar\/node(@\d+)?\/[^/]+\/bin\/node(\.exe)?$/i,
  );
  if (homebrewMatch) {
    const homebrewStable = `${homebrewMatch[1]}/bin/node${homebrewMatch[3] || ''}`;
    if (existsSync(homebrewStable)) return homebrewStable;
  }

  // mise pins a concrete node version at <data>/installs/node/<ver>/bin/node
  // (Windows: <data>/installs/node/<ver>/node.exe). Node realpaths
  // process.execPath to that versioned path, and `mise up` prunes old versions,
  // so a baked hook command 404s after any node bump — the same ephemeral-path
  // failure #977 fixed for fnm. The stable alias is the sibling shim
  // (<data>/shims/node), which always resolves to the active version, like the
  // Homebrew symlink survives `brew upgrade node`. Derive <data> from execPath
  // so a custom MISE_DATA_DIR layout still works, and only rewrite when the shim
  // exists — otherwise fall back to the raw execPath unchanged.
  const miseMatch = normalizedForMatch.match(
    /^(.*)\/installs\/node\/[^/]+\/(?:bin\/)?node(\.exe)?$/,
  );
  if (miseMatch) {
    const shim = `${miseMatch[1]}/shims/node${miseMatch[2] || ''}`;
    if (existsSync(shim)) return shim;
  }

  // volta pins a concrete node image at <VOLTA_HOME>/tools/image/node/<ver>/bin/node
  // (Windows: <VOLTA_HOME>/tools/image/node/<ver>/node.exe — volta's own layout
  // puts node.exe at the image root, no bin/). `volta uninstall node@<ver>` prunes
  // that image, so a baked hook command 404s — the same ephemeral-path failure
  // #977 fixed for fnm and #1619 for mise. The stable alias is the shim
  // <VOLTA_HOME>/bin/node, a symlink to volta-shim that always resolves to the
  // active pin. Derive <VOLTA_HOME> from execPath rather than the env so a custom
  // VOLTA_HOME and the Windows %LOCALAPPDATA%\Volta default both work (#2185's
  // reasoning), and only rewrite when the shim exists — otherwise fall back to
  // the raw execPath unchanged.
  const voltaMatch = normalizedForMatch.match(
    /^(.*)\/tools\/image\/node\/[^/]+\/(?:bin\/)?node(\.exe)?$/,
  );
  if (voltaMatch) {
    const shim = `${voltaMatch[1]}/bin/node${voltaMatch[2] || ''}`;
    if (existsSync(shim)) return shim;
  }
  return execPath;
}

function resolveNodeRunner(opts?: NodeNormOpts): string | null {
  const execPath = (opts && opts.execPath) || (typeof process.execPath === 'string' ? process.execPath : '');
  if (!execPath) return null;
  const stablePath = normalizeNodePath(execPath, opts);
  return JSON.stringify(shellCmdProjection.posixNormalize(stablePath));
}

/**
 * #3662 — the runtime-resolving node runner token for managed JS hooks.
 *
 * A bake-time absolute runner (`resolveNodeRunner`) only works in the
 * environment that ran the installer; a config root shared across
 * environments (the `--portable-hooks` scenario, or any settings.json under a
 * mounted `$HOME`) carries a path that 404s with exit 127 everywhere else.
 * This token is a POSIX `sh` command substitution that resolves node at
 * hook-fire time, trying IN ORDER:
 *
 *   1. the baked installer path (absolute — keeps the #2979/#3002/#3017/#3022
 *      minimal-PATH guarantee: where the baked path exists it still wins,
 *      under any PATH, GUI launch included);
 *   2. `command -v node` (quoted — one word even with spaces in the result);
 *   3. the well-known stable layouts (`/usr/local/bin/node`, `/usr/bin/node`).
 *
 * The FIRST executable candidate wins; if none resolves the substitution
 * yields an empty word and the hook fails exactly as a stale absolute path
 * does today — no bare `node` token is ever emitted or depended on.
 *
 * One shape for every platform: emitted hook commands execute via POSIX `sh`
 * (Claude-on-win32 runs Git Bash per #166/#580; `hookCommandNeedsPowerShellCallOperator`
 * is an unused opt-in), and the baked path is posixNormalize'd before escaping
 * (escapePosixDoubleQuoted — the Shell Command Projection seam owns quoting).
 * The portable resolver script (hooks/gsd-node-runner.sh) resolves through a
 * SUPERSET of this candidate list — keep the two lists consistent.
 */
function buildNodeRunnerChainToken(opts?: NodeNormOpts): string | null {
  const execPath = (opts && opts.execPath) || (typeof process.execPath === 'string' ? process.execPath : '');
  if (!execPath) return null;
  const stablePath = shellCmdProjection.posixNormalize(normalizeNodePath(execPath, opts));
  const baked = escapePosixDoubleQuoted(stablePath);
  // Absolute candidates only (leading / or a win32 drive letter): a relative
  // `command -v node` hit (legal under a relative PATH entry) must never
  // promote repo-cwd content into the runner slot. The gate uses parameter
  // expansion + [ ] — deliberately NO `case` (its `)` terminates the command
  // substitution under macOS's stock bash 3.2 /bin/sh, breaking the hook).
  // \${…} below stays a literal shell parameter expansion, not TS interpolation.
  return `"$(for n in "${baked}" "$(command -v node)" /usr/local/bin/node /usr/bin/node; do [ -x "$n" ] && { [ "\${n#/}" != "$n" ] || [ "\${n#?:}" != "$n" ]; } && printf '%s' "$n" && break; done)"`;
}

/**
 * #3662 — the install-time node path as a shell-safe QUOTED token, carrying
 * the same double-quote escaping as the chain token (`escapePosixDoubleQuoted`
 * — $ ` " \), NOT bare JSON quoting. The portable resolver's first argument
 * is executed by the host shell before the resolver sees argv, so a path
 * containing shell metacharacters must arrive escaped.
 */
function buildBakedNodeToken(opts?: NodeNormOpts): string | null {
  const execPath = (opts && opts.execPath) || (typeof process.execPath === 'string' ? process.execPath : '');
  if (!execPath) return null;
  const stablePath = shellCmdProjection.posixNormalize(normalizeNodePath(execPath, opts));
  return `"${escapePosixDoubleQuoted(stablePath)}"`;
}

/**
 * #3662 — basename of the portable node resolver staged into the install's
 * hooks/ directory. Under `--portable-hooks`, managed JS hook commands route
 * through it (`bash "<hooks>/gsd-node-runner.sh" "<baked-node>" "<script>.js"`)
 * so the SAME staged file works for every install: the install-time node path
 * travels as the resolver's first argument (tried first — the minimal-PATH
 * guarantee), ahead of `command -v node` and the well-known fallback list.
 */
const NODE_RUNNER_RESOLVER_HOOK = 'gsd-node-runner.sh';

interface BashRunnerOpts {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (p: string) => boolean;
}

/**
 * The one Git Bash policy: `bash` off win32; on win32 GSD_BASH_PATH, then the
 * well-known Git for Windows install locations, never a PATH lookup (which
 * can reach WSL's System32 launcher). null when win32 has no Git Bash.
 * #5082: the test process seam (tests/helpers/process-seam.cjs) resolves
 * `bash` through this too, so hooks and bash-driven tests run under the same
 * bash.
 */
function resolveBashExecutable(opts?: BashRunnerOpts): string | null {
  const platform = (opts && opts.platform) || process.platform;
  if (platform !== 'win32') return 'bash';

  const env = (opts && opts.env) || process.env;
  const exists = (opts && opts.existsSync) || fs.existsSync;
  const candidates: string[] = [];
  if (env.GSD_BASH_PATH) candidates.push(env.GSD_BASH_PATH);
  if (env.ProgramFiles) candidates.push(path.win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
  if (env['ProgramFiles(x86)']) candidates.push(path.win32.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'));
  if (env.SystemDrive) {
    candidates.push(path.win32.join(env.SystemDrive, 'Program Files', 'Git', 'bin', 'bash.exe'));
    candidates.push(path.win32.join(env.SystemDrive, 'Program Files (x86)', 'Git', 'bin', 'bash.exe'));
  }

  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return shellCmdProjection.posixNormalize(candidate);
  }
  return null;
}

function resolveBashRunner(opts?: BashRunnerOpts): string | null {
  const executable = resolveBashExecutable(opts);
  if (executable === null) return null;
  return ((opts && opts.platform) || process.platform) === 'win32'
    ? JSON.stringify(executable)
    : executable;
}

// ---------------------------------------------------------------------------
// Shared: rewriteLegacyManagedNodeHookCommands
// ---------------------------------------------------------------------------

interface HookEntry {
  command?: string;
  args?: unknown[];
  timeout?: number;
}

interface HookGroup {
  hooks?: HookEntry[];
}

interface SettingsHooks {
  [event: string]: HookGroup[];
}

interface Settings {
  hooks?: SettingsHooks;
}

interface RewriteOpts {
  platform?: string;
  runtime?: string;
}

// #3662 — recognize the two runtime-resolving command shapes the installer
// emits, so the rewriter never churns (or un-does) an entry that already
// works in every environment sharing the config root.
const CHAIN_RUNNER_COMMAND = /^"\$\(for n in [\s\S]*?printf '%s' "\$n" && break; done\)"\s+\S/;
const RESOLVER_RUNNER_COMMAND = /^(?:"[^"]*bash(\.exe)?"|bash)\s+"[^"]*gsd-node-runner\.sh"\s+"[^"]*"\s+\S/;

function rewriteLegacyManagedNodeHookCommands(settings: Settings, runnerToken: string, opts?: RewriteOpts): boolean {
  if (!settings || !settings.hooks || !runnerToken) return false;
  if (!opts) opts = {};
  const platform = opts.platform || process.platform;
  let changed = false;
  for (const entries of Object.values(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (!h || typeof h.command !== 'string') continue;
        if (Array.isArray(h.args) && h.args.length > 0) continue;
        let trimmed = h.command.trim();
        const hadPowerShellCallOperator = platform === 'win32' && /^&\s+/.test(trimmed);
        if (hadPowerShellCallOperator) {
          trimmed = trimmed.replace(/^&\s+/, '').trim();
        }
        if (CHAIN_RUNNER_COMMAND.test(trimmed) || RESOLVER_RUNNER_COMMAND.test(trimmed)) continue;

        const m = trimmed.match(/^node\s+("([^"]+)"|'([^']+)'|(\S+))\s*$/) ||
                  trimmed.match(/^("([^"]+)"|'([^']+)'|(\S+))\s+("([^"]+)"|'([^']+)'|(\S+))\s*$/);
        if (!m) continue;

        let scriptToken: string, scriptPath: string;
        if (/^node\s+/.test(trimmed)) {
          scriptToken = m[1];
          scriptPath = m[2] || m[3] || m[4] || '';
        } else {
          // #3662: the pre-fix two-token shape baked an absolute node path at
          // install time. A foreign-but-stable runner (valid in the
          // environment that wrote it, absent here) used to be SKIPPED — the
          // exact mechanism behind the mixed state where no environment can
          // run all hooks. Every two-token managed entry now re-projects onto
          // the runtime-resolving runner, whatever environment baked it.
          scriptToken = m[5];
          scriptPath = m[6] || m[7] || m[8] || '';
        }

        if (!isManagedHookBasename(scriptPath, { surface: 'settings-json' })) continue;

        const projectedCommand = projectLegacySettingsHookCommand({
          runnerToken,
          scriptPath,
          scriptToken,
          runtime: opts.runtime || 'generic',
          platform,
        });
        if (!projectedCommand) continue;
        if (h.command === projectedCommand) continue;

        h.command = projectedCommand;
        changed = true;
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Shared: reconcileManagedShellHookCommands (#3329)
// ---------------------------------------------------------------------------

/**
 * Rewrite already-registered managed `.sh` hook `command` strings to the shape
 * the current installer would generate (#3329).
 *
 * applySettingsJsonHooks registers the four `.sh` managed hooks only-if-absent,
 * so an entry registered by an older installer keeps its old command forever —
 * `/gsd-update` (which re-invokes the installer) never re-derived it. On
 * Claude/win32 that left the pre-#580/#3393 bash-runner-prefixed commands
 * (`bash "<script>.sh"`, `"<git>/bash.exe" "<script>.sh"`) in place, spawning a
 * nested bash on every hook fire. The #2979 rewriter above cannot help: it is
 * Node-only by design (its basename gate contains only `.js` filenames).
 *
 * Scoping / safety:
 * - Inert unless `shellHookOmitsBashRunner({ platform, runtime, isShellHook:
 *   true })` — the exact combination whose correct command shape changed. Where
 *   the bash runner is still correct (non-Windows, non-claude), nothing is
 *   rewritten, so the reconcile cannot churn unrelated installs.
 * - Only entries whose parsed script token's basename exactly equals one of the
 *   expected managed `.sh` filenames are touched. A user hook would have to
 *   live at a path ending in exactly `gsd-session-state.sh` etc. — i.e. the
 *   GSD-installed file — to match. Extra-token commands (env prefixes, extra
 *   args) and args-form launcher entries (#976) never match the strict
 *   `[runner ]<script>` two-token shape and are left alone.
 * - A null/empty expected command disables rewriting for that hook (a
 *   bash-runner-unavailable install must not have its entry nulled).
 *
 * @param settings settings.json-shaped object; mutated in place
 * @param expected map of managed `.sh` filename → the command this install
 *   would register today (from buildHookCommand / buildLocalShellHookCommand)
 * @param opts platform/runtime override (default: current process)
 * @returns true when any command was rewritten
 */
function reconcileManagedShellHookCommands(
  settings: Settings,
  expected: Record<string, string | null | undefined>,
  opts?: RewriteOpts
): boolean {
  if (!settings || !settings.hooks || !expected) return false;
  if (!opts) opts = {};
  const platform = opts.platform || process.platform;
  const runtime = opts.runtime || 'generic';
  if (!shellHookOmitsBashRunner({ platform, runtime, isShellHook: true })) return false;

  const expectedByBasename = new Map<string, string>();
  for (const [hookFile, command] of Object.entries(expected)) {
    if (typeof command === 'string' && command.length > 0) {
      expectedByBasename.set(hookFile, command);
    }
  }
  if (expectedByBasename.size === 0) return false;

  let changed = false;
  for (const entries of Object.values(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (!h || typeof h.command !== 'string') continue;
        if (Array.isArray(h.args) && h.args.length > 0) continue;
        let trimmed = h.command.trim();
        const hadPowerShellCallOperator = platform === 'win32' && /^&\s+/.test(trimmed);
        if (hadPowerShellCallOperator) {
          trimmed = trimmed.replace(/^&\s+/, '').trim();
        }
        // Strict `[runner ]<script>` shape: an optional single runner token
        // (bare, 'single-quoted', or "double-quoted") followed by the script
        // token. Anything else (env prefixes, extra flags, pipelines) does not
        // match and is left untouched.
        const m = trimmed.match(/^(?:(?:"([^"]+)"|'([^']+)'|(\S+))\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/);
        if (!m) continue;
        const scriptToken = m[4] || m[5] || m[6] || '';
        if (!scriptToken) continue;
        const basename = shellCmdProjection.posixNormalize(scriptToken).split('/').pop() || '';
        const expectedCommand = expectedByBasename.get(basename);
        if (!expectedCommand) continue;
        if (h.command === expectedCommand) continue;

        h.command = expectedCommand;
        changed = true;
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Codex TOML hook block builder
// ---------------------------------------------------------------------------

interface BuildCodexHookBlockOpts {
  absoluteRunner?: string | null;
  eol?: string;
  platform?: string;
}

function buildCodexHookBlock(targetDir: string, opts?: BuildCodexHookBlockOpts): string | null {
  const absoluteRunner = opts && opts.absoluteRunner;
  if (!absoluteRunner) return null;
  const eol = (opts && opts.eol) || '\n';
  const platform = (opts && opts.platform) || process.platform;
  const updateCheckScript = path.resolve(targetDir, 'hooks', 'gsd-check-update.js');
  const commandValue = projectCodexHookTomlCommand({
    absoluteRunner,
    scriptPath: updateCheckScript,
    platform,
  });
  return `${eol}# GSD Hooks${eol}` +
    `[[hooks.SessionStart]]${eol}` +
    `${eol}` +
    `[[hooks.SessionStart.hooks]]${eol}` +
    `type = "command"${eol}` +
    `command = "${commandValue}"${eol}`;
}

// ---------------------------------------------------------------------------
// Codex TOML legacy-hook rewriter
// ---------------------------------------------------------------------------

interface RewriteLegacyResult {
  content: string;
  changed: boolean;
}

function rewriteLegacyCodexHookBlock(content: string, absoluteRunner: string | null, opts?: { platform?: string }): RewriteLegacyResult {
  if (!content || !absoluteRunner) return { content, changed: false };
  const platform = (opts && opts.platform) || process.platform;
  let changed = false;
  const updated = content.replace(
    /^(command\s*=\s*")node\s+((?:\\"[^"]+\\"|\S+))("\s*)$/gm,
    (full: string, prefix: string, scriptToken: string, suffix: string) => {
      const quoted = scriptToken.match(/^\\"([\s\S]+)\\"$/);
      let scriptPath = scriptToken;
      if (quoted) {
        try {
          scriptPath = String(parseTomlValue(`"${quoted[1]}"`, 0).value);
        } catch {
          scriptPath = quoted[1];
        }
      }
      if (!isManagedHookBasename(scriptPath, { surface: 'codex-toml' })) return full;
      const desiredCommand = projectCodexHookTomlCommand({
        absoluteRunner,
        scriptPath,
        platform,
      });
      const currentCommand = `${prefix}${scriptToken}${suffix}`.replace(/^(command\s*=\s*")|("\s*)$/g, '');
      if (currentCommand === desiredCommand) return full;
      changed = true;
      return `${prefix}${desiredCommand}${suffix}`;
    },
  );
  return { content: updated, changed };
}

// ---------------------------------------------------------------------------
// Codex hooks.json: reconcileCodexHooksJsonEvent
// ---------------------------------------------------------------------------

interface ReconcileCodexOpts {
  managedCommand?: string | null;
  commandWindows?: string | null;
  matcher?: string | null;
  timeout?: number | null;
}

interface ReconcileResult {
  changed: boolean;
  wrote: boolean;
  path: string;
  configuredEntrypoints?: ConfiguredEntrypoint[];
}

/**
 * Lazily require install-engine.cjs's `hasExistingSymlinkBetween` /
 * `isSymlinkedDestOptIn` — mirrors user-artifact-staging.cts's
 * `_installEngineSymlinkGuard` (same call-time-require rationale: avoid a
 * static circular require between install-engine.cts and this module).
 */
interface InstallEngineSymlinkGuard {
  hasExistingSymlinkBetween: (root: string, fullPath: string, options?: { allowOptInFollow?: boolean }) => boolean;
  isSymlinkedDestOptIn: () => boolean;
}

function _installEngineSymlinkGuard(): InstallEngineSymlinkGuard {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const mod: InstallEngineSymlinkGuard = require('./install-engine.cjs');
  return mod;
}

function reconcileCodexHooksJsonEvent(targetDir: string, eventName: string, opts: ReconcileCodexOpts = {}): ReconcileResult {
  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  const managedCommand = typeof opts.managedCommand === 'string' ? opts.managedCommand : null;
  const commandWindows = typeof opts.commandWindows === 'string' ? opts.commandWindows : null;
  const matcher = typeof opts.matcher === 'string' ? opts.matcher : undefined;
  const timeout = typeof opts.timeout === 'number' ? opts.timeout : undefined;
  // #2586 Major 2: every Codex hooks.json writer funnels through this one
  // function, and atomicWriteFileSync's final step is a rename(2) onto
  // `hooksJsonPath` — which, when that path is a symlink, REPLACES the
  // symlink with a plain file rather than writing through it. Refuse (with
  // the same GSD_ALLOW_SYMLINKED_DEST opt-in every other install call site
  // honors) before reading or writing, so a symlinked hooks.json is neither
  // silently destroyed nor left the caller no escape hatch.
  const symlinkGuard = _installEngineSymlinkGuard();
  // The path this function actually reads/writes. Defaults to the nominal
  // hooks.json path; reassigned below to the symlink's real target when the
  // opt-in is active, so the write lands on the file the user's symlink
  // points at instead of clobbering the symlink itself (see note below).
  let effectiveHooksJsonPath = hooksJsonPath;
  if (fs.existsSync(hooksJsonPath) && fs.lstatSync(hooksJsonPath).isSymbolicLink()) {
    if (
      symlinkGuard.hasExistingSymlinkBetween(targetDir, hooksJsonPath, {
        allowOptInFollow: symlinkGuard.isSymlinkedDestOptIn(),
      })
    ) {
      throw new Error(
        `hooks.json at "${hooksJsonPath}" contains a symlink the install root "${targetDir}" does not trust — ` +
          'refusing to read or write it. If this is an intentional user-owned symlink layout, re-run with ' +
          'GSD_ALLOW_SYMLINKED_DEST=1.',
      );
    }
    // hasExistingSymlinkBetween returned false only because the opt-in is
    // active (a symlinked leaf always trips it otherwise) — so this IS a
    // symlink and we are cleared to follow it. atomicWriteFileSync's final
    // step is a rename(2) onto its target, which REPLACES an existing
    // symlink at that path rather than writing through it; resolving to the
    // real path here makes the read AND the write operate on the symlink's
    // target, leaving the symlink itself untouched, matching what "follow"
    // is supposed to mean.
    effectiveHooksJsonPath = fs.realpathSync(hooksJsonPath);
  }
  let parsed: Record<string, unknown> = {};
  let currentContent: string | null = null;
  if (fs.existsSync(effectiveHooksJsonPath)) {
    const raw = fs.readFileSync(effectiveHooksJsonPath, 'utf8');
    currentContent = raw;
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`hooks.json parse failed: ${err && (err as Error).message ? (err as Error).message : String(err)}`);
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};

  const usesNestedHooksObject =
    parsed['hooks'] && typeof parsed['hooks'] === 'object' && !Array.isArray(parsed['hooks']);
  // #1348: canonicalize every write to the nested { hooks: { <Event>: [...] } }
  // shape. Lift ANY top-level event array (legacy, empty, OR mixed nested+top-level)
  // into the nested table — merging when the same event exists in both — so
  // user/legacy entries are preserved under `hooks` and no stray top-level event
  // key survives (Codex deny_unknown_fields rejects them). Mirrors reconcileCursorHooksJson.
  const hookTable: Record<string, unknown> = usesNestedHooksObject
    ? (parsed['hooks'] as Record<string, unknown>)
    : {};
  for (const key of Object.keys(parsed)) {
    if (key === 'hooks') continue;
    if (Array.isArray(parsed[key])) {
      const lifted = parsed[key] as unknown[];
      const existing = Array.isArray(hookTable[key]) ? (hookTable[key] as unknown[]) : [];
      hookTable[key] = [...lifted, ...existing];
      delete parsed[key];
    }
  }
  parsed['hooks'] = hookTable;
  const eventEntries = Array.isArray(hookTable[eventName]) ? (hookTable[eventName] as unknown[]) : [];
  // Minor 5 (#2586 review): an event key the user already had, already
  // holding an empty array, must survive removal as an empty array — not be
  // deleted outright. Deleting is only correct when OUR removal is what
  // emptied a previously non-empty array. Tracked before the loop below can
  // mutate anything.
  const wasArrayEmpty = Array.isArray(hookTable[eventName]) && eventEntries.length === 0;

  let removedLegacy = false;
  const sanitizedEntries: unknown[] = [];
  for (const entry of eventEntries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const entryObj = entry as Record<string, unknown>;
    const originalHooks = Array.isArray(entryObj['hooks']) ? (entryObj['hooks'] as unknown[]) : [];
    if (originalHooks.length === 0) {
      sanitizedEntries.push(entry);
      continue;
    }
    const keptHooks = originalHooks.filter((hook) => {
      const cmd = hook && typeof hook === 'object' ? (hook as Record<string, unknown>)['command'] : null;
      const managed = isManagedHookCommand(cmd as string | null | undefined, {
        surface: 'codex-hooks-json',
        includeLegacyAliases: true,
        configDir: targetDir,
      });
      if (managed) removedLegacy = true;
      return !managed;
    });
    if (keptHooks.length === 0) continue;
    const nextEntry = { ...entryObj, hooks: keptHooks };
    sanitizedEntries.push(nextEntry);
  }

  if (managedCommand) {
    const hookEntry: Record<string, unknown> = { type: 'command', command: managedCommand };
    if (commandWindows) hookEntry['commandWindows'] = commandWindows;
    if (timeout !== undefined) hookEntry['timeout'] = timeout;
    const newEntry: Record<string, unknown> = { hooks: [hookEntry] };
    if (matcher !== undefined) newEntry['matcher'] = matcher;
    sanitizedEntries.push(newEntry);
  }

  if (sanitizedEntries.length > 0) {
    hookTable[eventName] = sanitizedEntries;
  } else if (wasArrayEmpty) {
    // Nothing of ours was ever here to remove — preserve the user's own
    // empty array exactly as found (Minor 5).
    hookTable[eventName] = [];
  } else {
    delete hookTable[eventName];
  }

  // Avoid writing an empty `{ "hooks": {} }` artifact (e.g. removal on an absent
  // file): collapse an empty hook table back to `{}` so the existing
  // shouldWrite/no-write-on-empty behavior is preserved.
  if (Object.keys(hookTable).length === 0) delete parsed['hooks'];

  const nextContent = `${JSON.stringify(parsed, null, 2)}\n`;
  const changed = currentContent !== nextContent;
  const shouldWrite = changed && (currentContent !== null || Object.keys(parsed).length > 0);
  if (shouldWrite) {
    atomicWriteFileSync(effectiveHooksJsonPath, nextContent, 'utf8');
  }

  return { changed: changed || removedLegacy, wrote: shouldWrite, path: hooksJsonPath };
}

// ---------------------------------------------------------------------------
// reconcileCodexHooksJsonSessionStart
// ---------------------------------------------------------------------------

interface ReconcileSessionStartOpts {
  managedCommand?: string | null;
  commandWindows?: string | null;
}

function reconcileCodexHooksJsonSessionStart(targetDir: string, opts: ReconcileSessionStartOpts = {}): ReconcileResult {
  return reconcileCodexHooksJsonEvent(targetDir, 'SessionStart', opts);
}

// ---------------------------------------------------------------------------
// buildCodexHookWindowsShimIR
// ---------------------------------------------------------------------------

interface ShimIR {
  invocation: { interpreter: string; target: string };
  cmdPath: string;
  hookCommand: string;
  eol: { cmd: string };
  passthroughArgs: boolean;
  render: { cmd: () => string };
}

function parseAbsoluteRunnerToken(absoluteRunnerToken: string): string {
  try {
    return JSON.parse(absoluteRunnerToken) as string;
  } catch {
    return absoluteRunnerToken;
  }
}

function buildCodexHookWindowsShimIR(scriptAbsPath: string, absoluteRunnerToken: string | null): ShimIR | null {
  if (!absoluteRunnerToken) return null;
  const interpreter = parseAbsoluteRunnerToken(absoluteRunnerToken);
  const targetAbs = shellCmdProjection.posixNormalize(scriptAbsPath);
  const scriptQuoted = JSON.stringify(targetAbs);
  const cmdPath = scriptAbsPath.replace(/\.js$/, '.cmd');
  const hookCommand = JSON.stringify(shellCmdProjection.posixNormalize(cmdPath));
  const runnerQuoted = JSON.stringify(interpreter);
  return {
    invocation: { interpreter, target: scriptAbsPath },
    cmdPath,
    hookCommand,
    eol: { cmd: '\r\n' },
    passthroughArgs: true,
    render: {
      cmd: () => `@ECHO OFF\r\n@SETLOCAL\r\n@${runnerQuoted} ${scriptQuoted} %*\r\n`,
    },
  };
}

// ---------------------------------------------------------------------------
// ensureCodexHooksJsonSessionStart
// ---------------------------------------------------------------------------

interface EnsureCodexSessionStartOpts {
  absoluteRunner?: string | null;
  platform?: NodeJS.Platform;
}

function ensureCodexHooksJsonSessionStart(targetDir: string, opts: EnsureCodexSessionStartOpts = {}): ReconcileResult {
  const platform = opts.platform || process.platform;
  const absoluteRunner = opts.absoluteRunner || null;
  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  if (!absoluteRunner) return { changed: false, wrote: false, path: hooksJsonPath };

  const scriptPath = shellCmdProjection.posixNormalize(path.resolve(targetDir, 'hooks', 'gsd-check-update.js'));
  const cmdShimPath = scriptPath.replace(/\.js$/, '.cmd');
  const configuredEntrypoints: ConfiguredEntrypoint[] = [];
  let managedCommand: string | undefined;

  if (platform === 'win32') {
    const shimIR = buildCodexHookWindowsShimIR(scriptPath, absoluteRunner);
    if (!shimIR) return { changed: false, wrote: false, path: hooksJsonPath };
    try {
      atomicWriteFileSync(shimIR.cmdPath, shimIR.render.cmd(), 'utf8');
    } catch (shimWriteErr) {
      const reason = shimWriteErr && (shimWriteErr as Error).message ? (shimWriteErr as Error).message : String(shimWriteErr);
      console.warn(
        `  ${yellow}⚠${reset}  Codex Windows hook NOT installed — .cmd shim write failed: ${reason}. ` +
          `Fix the write error (permissions? disk full?) and re-run the installer. ` +
          `Do NOT use the legacy node.exe command path — it triggers the #3426 bash.exe POSIX-exec failure.`,
      );
      return { changed: false, wrote: false, path: hooksJsonPath };
    }
    managedCommand = shimIR.hookCommand;
    configuredEntrypoints.push(
      { runtime: 'codex', configPath: hooksJsonPath, scriptPath: shimIR.cmdPath, platform, selfExecutable: true },
      { runtime: 'codex', configPath: hooksJsonPath, scriptPath, interpreterCandidates: [parseAbsoluteRunnerToken(absoluteRunner)], platform },
    );
  } else {
    managedCommand = projectManagedHookCommand({
      absoluteRunner,
      scriptPath,
      runtime: 'codex',
      platform,
    }) ?? undefined;
    if (managedCommand) {
      configuredEntrypoints.push({
        runtime: 'codex',
        configPath: hooksJsonPath,
        scriptPath,
        interpreterCandidates: [parseAbsoluteRunnerToken(absoluteRunner)],
        platform,
      });
    }
  }

  if (!managedCommand) return { changed: false, wrote: false, path: hooksJsonPath };
  const commandWindows = platform === 'win32'
    ? JSON.stringify(shellCmdProjection.posixNormalize(cmdShimPath))
    : undefined;
  const result = reconcileCodexHooksJsonSessionStart(targetDir, { managedCommand, commandWindows });
  return { ...result, configuredEntrypoints };
}

// ---------------------------------------------------------------------------
// ensureCodexHooksJsonEvent
// ---------------------------------------------------------------------------

interface EnsureCodexEventOpts {
  absoluteRunner?: string | null;
  platform?: NodeJS.Platform;
}

function ensureCodexHooksJsonEvent(targetDir: string, eventName: string, opts: EnsureCodexEventOpts = {}): ReconcileResult {
  const platform = opts.platform || process.platform;
  const absoluteRunner = opts.absoluteRunner || null;
  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  if (!absoluteRunner) return { changed: false, wrote: false, path: hooksJsonPath };

  const scriptPath = shellCmdProjection.posixNormalize(path.resolve(targetDir, 'hooks', 'gsd-context-monitor.js'));

  let managedCommand: string | undefined;
  if (platform === 'win32') {
    const shimIR = buildCodexHookWindowsShimIR(scriptPath, absoluteRunner);
    if (!shimIR) return { changed: false, wrote: false, path: hooksJsonPath };
    try {
      atomicWriteFileSync(shimIR.cmdPath, shimIR.render.cmd(), 'utf8');
    } catch (shimWriteErr) {
      const reason = shimWriteErr && (shimWriteErr as Error).message ? (shimWriteErr as Error).message : String(shimWriteErr);
      console.warn(
        `  ${yellow}⚠${reset}  Codex Windows hook NOT installed — .cmd shim write failed for ${eventName}: ${reason}. ` +
          `Fix the write error (permissions? disk full?) and re-run the installer.`,
      );
      return { changed: false, wrote: false, path: hooksJsonPath };
    }
    managedCommand = shimIR.hookCommand;
  } else {
    managedCommand = projectManagedHookCommand({
      absoluteRunner,
      scriptPath,
      runtime: 'codex',
      platform,
    }) ?? undefined;
  }

  if (!managedCommand) return { changed: false, wrote: false, path: hooksJsonPath };
  return reconcileCodexHooksJsonEvent(targetDir, eventName, { managedCommand, timeout: 10 });
}

// ---------------------------------------------------------------------------
// removeCodexHooksJsonEvent / removeCodexHooksJsonSessionStart
// ---------------------------------------------------------------------------

function removeCodexHooksJsonEvent(targetDir: string, eventName: string): ReconcileResult {
  return reconcileCodexHooksJsonEvent(targetDir, eventName, { managedCommand: null });
}

function removeCodexHooksJsonSessionStart(targetDir: string): ReconcileResult {
  return reconcileCodexHooksJsonSessionStart(targetDir, { managedCommand: null });
}

// ---------------------------------------------------------------------------
// #2586: cleanupOrphanedCodexContextMonitorScript
// ---------------------------------------------------------------------------

interface CleanupCodexContextMonitorResult {
  /** Absolute paths of files actually deleted this call. */
  deleted: string[];
  /** {path, reason} for a file that could NOT be deleted (still present). */
  warnings: { path: string; reason: string }[];
  /** True if a surviving hooks.json registration still references the
   *  script (or its .cmd shim) — in which case nothing was deleted. */
  stillReferenced: boolean;
}

// Literal, version-stable markers every shipped gsd-context-monitor.js
// carries. Stable across the {{GSD_VERSION}} and runtime-path substitutions
// the Codex copy step applies (#2586 design doc "Ownership check" — a raw
// content hash would differ per runtime/version by construction, so a marker
// check is used instead of manifest-membership, which has a bootstrap gap on
// the exact case that matters most: a pre-#2586 install's manifest never
// recorded this file at all).
const CODEX_CONTEXT_MONITOR_OWNERSHIP_MARKERS = [
  '#!/usr/bin/env node',
  '// gsd-hook-version:',
  '// Context Monitor - PostToolUse/AfterTool hook',
];

function isGsdOwnedCodexContextMonitorScript(filePath: string): boolean {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  // The .cmd shim (buildCodexHookWindowsShimIR) is a tiny generated batch
  // wrapper, not the JS file itself — it never carries the JS markers above,
  // so it gets its own narrower, still-specific signature: the exact
  // "@ECHO OFF" / "@SETLOCAL" preamble the shim generator emits, invoking a
  // script path that ends in gsd-context-monitor.js.
  if (filePath.endsWith('.cmd')) {
    return content.startsWith('@ECHO OFF') && content.includes('@SETLOCAL')
      && /gsd-context-monitor\.js/.test(content);
  }
  return CODEX_CONTEXT_MONITOR_OWNERSHIP_MARKERS.every((marker) => content.includes(marker));
}

/**
 * Scan every event in hooks.json for a surviving reference to the
 * context-monitor script or its Windows .cmd shim, by basename — not scoped
 * to CODEX_EXTENDED_HOOK_EVENTS, so a user who hand-registered it under an
 * unrelated event key is still detected as "referenced" and the script is
 * preserved.
 */
function hooksJsonReferencesCodexContextMonitor(targetDir: string): boolean {
  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  if (!fs.existsSync(hooksJsonPath)) return false;
  let raw: string;
  try {
    raw = fs.readFileSync(hooksJsonPath, 'utf8');
  } catch {
    return true; // unreadable — conservatively assume referenced, never delete
  }
  if (!raw.trim()) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return true; // unparseable — conservatively assume referenced
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const hooks = (parsed as Record<string, unknown>)['hooks'];
  const table = hooks && typeof hooks === 'object' && !Array.isArray(hooks)
    ? (hooks as Record<string, unknown>)
    : (parsed as Record<string, unknown>);
  for (const key of Object.keys(table)) {
    const entries = table[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const entryHooks = (entry as Record<string, unknown>)['hooks'];
      const hookList = Array.isArray(entryHooks) ? entryHooks : [entry];
      for (const hook of hookList) {
        if (!hook || typeof hook !== 'object') continue;
        const values = [
          (hook as Record<string, unknown>)['command'],
          (hook as Record<string, unknown>)['commandWindows'],
        ];
        for (const value of values) {
          if (typeof value === 'string' && /gsd-context-monitor(\.js|\.cmd)?/.test(value)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * #2586 must-have #4/#8: after hooks.json registrations for
 * CODEX_EXTENDED_HOOK_EVENTS have been reconciled away (by the caller, via
 * removeCodexHooksJsonEvent), delete `hooks/gsd-context-monitor.js` and its
 * `.cmd` shim ONLY when (a) no surviving hooks.json registration under ANY
 * event still references either basename, and (b) the on-disk file carries
 * GSD's own ownership markers (a user's hand-edited or unrelated file at that
 * path is left alone). Each file is deleted independently — a failure
 * deleting one is reported as a warning and never rolls back the (already
 * safe, already-written) hooks.json deregistration the caller performed
 * first.
 */
function cleanupOrphanedCodexContextMonitorScript(targetDir: string): CleanupCodexContextMonitorResult {
  const result: CleanupCodexContextMonitorResult = { deleted: [], warnings: [], stillReferenced: false };
  if (hooksJsonReferencesCodexContextMonitor(targetDir)) {
    result.stillReferenced = true;
    return result;
  }
  const candidates = [
    path.join(targetDir, 'hooks', 'gsd-context-monitor.js'),
    path.join(targetDir, 'hooks', 'gsd-context-monitor.cmd'),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (!isGsdOwnedCodexContextMonitorScript(candidate)) continue;
    try {
      fs.unlinkSync(candidate);
      result.deleted.push(candidate);
    } catch (err) {
      result.warnings.push({
        path: candidate,
        reason: err && (err as Error).message ? (err as Error).message : String(err),
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Shared: buildHookCommand
// ---------------------------------------------------------------------------

interface BuildHookCommandOpts {
  portableHooks?: boolean;
  platform?: string;
  runtime?: string;
  hookShell?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  existsSync?: (p: string) => boolean;
  configPath?: string;
  configuredEntrypoints?: ConfiguredEntrypoint[];
}

function configuredEntrypointsForHook(
  configDir: string,
  hookName: string,
  opts: BuildHookCommandOpts,
): ConfiguredEntrypoint[] {
  const platform = opts.platform || process.platform;
  const runtime = opts.runtime || 'generic';
  const configPath = opts.configPath || configDir;
  const target: ConfiguredEntrypoint = {
    runtime,
    configPath,
    scriptPath: path.join(configDir, 'hooks', hookName),
    platform,
  };
  const isShellHook = hookName.endsWith('.sh');

  if (shellHookOmitsBashRunner({ platform, runtime, isShellHook })) return [{ ...target, selfExecutable: true }];

  const bash = resolveBashExecutable(opts);
  if (isShellHook) {
    // An unresolved bash must still surface as an interpreterCandidates entry
    // (the sentinel token, same as the portableHooks runner below) so
    // validateConfiguredEntrypoints reports 'unresolved-interpreter' instead
    // of silently skipping the check because the field is absent.
    return [{ ...target, interpreterCandidates: [bash === null ? UNRESOLVED_BASH_SENTINEL : bash] }];
  }

  // #4249: check the SAME stable alias buildNodeRunnerChainToken bakes as its
  // first candidate (normalizeNodePath rewrites a version-manager shim like
  // fnm/nvm/mise/volta into its persistent path), not the raw, currently-
  // running process.execPath — which always trivially resolves regardless of
  // whether the alias actually baked into the persisted command still does.
  const nodeCandidates = [
    normalizeNodePath(opts.execPath || process.execPath, opts),
    'node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter((candidate): candidate is string => Boolean(candidate));

  if (!opts.portableHooks) {
    return [{ ...target, interpreterCandidates: nodeCandidates }];
  }

  const runner: ConfiguredEntrypoint = {
    runtime,
    configPath,
    scriptPath: path.join(configDir, 'hooks', NODE_RUNNER_RESOLVER_HOOK),
    interpreterCandidates: bash === null ? [UNRESOLVED_BASH_SENTINEL] : [bash],
    platform,
  };
  return [runner, { ...target, interpreterCandidates: nodeCandidates }];
}

function recordConfiguredHookCommand(
  command: string | null,
  configDir: string,
  hookName: string,
  opts: BuildHookCommandOpts,
): string | null {
  if (command && opts.configuredEntrypoints) {
    opts.configuredEntrypoints.push(
      ...configuredEntrypointsForHook(configDir, hookName, opts).map(entry => ({ ...entry, command })),
    );
  }
  return command;
}

// #5100: the two null-runner branches of buildHookCommand share this. No
// command was ever built, so track() (which needs one) cannot record the
// hook — push the entry directly instead, so the gate sees it rather than
// the hook going silently unregistered.
function recordUnresolvedBashEntrypoint(
  configDir: string,
  hookName: string,
  opts: BuildHookCommandOpts,
): void {
  if (opts.configuredEntrypoints) {
    opts.configuredEntrypoints.push(...configuredEntrypointsForHook(configDir, hookName, opts));
  }
}

function buildHookCommand(configDir: string, hookName: string, opts?: BuildHookCommandOpts): string | null {
  if (!opts) opts = {};
  const platform = opts.platform || process.platform;
  const runtime = opts.runtime || 'generic';
  const hookShell = opts.hookShell;
  const isShellHook = hookName.endsWith('.sh');
  const track = (command: string | null): string | null =>
    recordConfiguredHookCommand(command, configDir, hookName, opts);

  if (shellHookOmitsBashRunner({ platform, runtime, isShellHook })) {
    if (opts.portableHooks) {
      const portableBaseDir = projectPortableHookBaseDir({
        configDir,
        homeDir: os.homedir(),
      });
      return track(JSON.stringify(`${portableBaseDir}/hooks/${hookName}`));
    }
    return track(JSON.stringify(shellCmdProjection.posixNormalize(configDir) + '/hooks/' + hookName));
  }

  // .sh hooks keep the pre-#3662 shape everywhere: the bash runner resolves
  // at install time like today, and `bash` itself is a PATH-stable binary
  // (the absolute Git-Bash discovery covers win32 — #580/#3393).
  if (isShellHook) {
    const runner = resolveBashRunner(opts);
    if (runner === null) {
      // #4249 (antigravity review): this early return skips `track()` below,
      // which needs a command that was never built — record the entry
      // directly so the gate can reject it.
      recordUnresolvedBashEntrypoint(configDir, hookName, opts);
      return null;
    }

    if (opts.portableHooks) {
      const portableBaseDir = projectPortableHookBaseDir({
        configDir,
        homeDir: os.homedir(),
      });
      return track(projectManagedHookCommand({
        absoluteRunner: runner,
        scriptPath: `${portableBaseDir}/hooks/${hookName}`,
        runtime: opts.runtime || 'generic',
        platform,
        hookShell,
      }));
    }

    const hooksPath = shellCmdProjection.posixNormalize(configDir) + '/hooks/' + hookName;
    return track(projectManagedHookCommand({
      absoluteRunner: runner,
      scriptPath: hooksPath,
      runtime,
      platform,
      hookShell,
    }));
  }

  // JS hooks (#3662): the node runner is resolved at hook-fire time, never
  // baked as a bare absolute path — an install-environment absolute path is
  // exactly what breaks with exit 127 when the config root is shared across
  // environments with different node layouts.

  if (opts.portableHooks) {
    // Portable installs route through the staged resolver: the baked absolute
    // path travels as the resolver's FIRST argument (tried first, so the
    // minimal-PATH guarantee holds), then `command -v node`, then the
    // well-known list — one staged file, no per-install templating. The
    // token is shell-escaped like the chain (the host shell expands the
    // argument before bash sees argv), not merely JSON-quoted.
    const bakedToken = buildBakedNodeToken(opts);
    if (bakedToken === null) return null;
    const portableBaseDir = projectPortableHookBaseDir({
      configDir,
      homeDir: os.homedir(),
    });
    // #5100: same contract as the .sh early return. A bare `bash` is how
    // win32 reaches WSL's System32 launcher, and the gate used to accept it.
    const resolverRunner = resolveBashRunner(opts);
    if (resolverRunner === null) {
      recordUnresolvedBashEntrypoint(configDir, hookName, opts);
      return null;
    }
    return track(shellCmdProjection.projectShellCommandText({
      runnerToken: resolverRunner,
      argTokens: [
        JSON.stringify(`${portableBaseDir}/hooks/${NODE_RUNNER_RESOLVER_HOOK}`),
        bakedToken,
        JSON.stringify(`${portableBaseDir}/hooks/${hookName}`),
      ],
      runtime,
      platform,
      hookShell,
    }));
  }

  const chainRunner = buildNodeRunnerChainToken(opts);
  if (chainRunner === null) return null;
  const hooksPath = shellCmdProjection.posixNormalize(configDir) + '/hooks/' + hookName;
  return track(shellCmdProjection.projectShellCommandText({
    runnerToken: chainRunner,
    argTokens: [JSON.stringify(hooksPath)],
    runtime,
    platform,
    hookShell,
  }));
}

// ---------------------------------------------------------------------------
// Cline helpers
// ---------------------------------------------------------------------------

function buildClineRulesBody(): string {
  return [
    '# GSD Core — Git. Ship. Done.',
    '',
    '- GSD workflows live in `gsd-core/workflows/`. Load the relevant workflow when',
    '  the user runs a `/gsd-*` command.',
    '- GSD agents live in `agents/`. Use the matching agent when spawning subagents.',
    '- GSD tools are at `gsd-core/bin/gsd-tools.cjs`. Run with `node`.',
    '- Planning artifacts live in `.planning/`. Never edit them outside a GSD workflow.',
    '- Do not apply GSD workflows unless the user explicitly asks for them.',
    '- When a GSD command triggers a deliverable (feature, fix, docs), offer the next',
    '  step to the user using Cline\'s ask_user tool after completing it.',
  ].join('\n') + '\n';
}

function buildClineAgentsMdBody(): string {
  return buildClineRulesBody();
}

function buildClinePreToolUseHook(): string {
  return `#!/usr/bin/env node
'use strict';
/* GSD-managed Cline PreToolUse hook — gsd-core issue #787.
 * Protocol: JSON on stdin -> JSON decision on stdout.
 * Honored fields: { cancel, errorMessage, contextModification }.
 * Fails open: any error allows the operation. */
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const allow = () => process.stdout.write(JSON.stringify({ cancel: false }));
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { return allow(); }
  try {
    const tool = String(
      input.toolName || input.tool_name || input.tool ||
      (input.toolInput && input.toolInput.name) || (input.tool_input && input.tool_input.name) || ''
    ).toLowerCase();
    const isWrite = /write|edit|replace|create|delete|remove|append|apply|patch|insert|mkdir/.test(tool);
    // Collect only PATH-bearing field values (not free-form content), so a doc
    // that merely mentions ".planning/" in its body is never falsely blocked.
    const paths = [];
    const PATH_KEY = /^(path|file|file_?path|filepath|target_?path|target|dir|directory|uri|filename)$/i;
    const walk = (v, depth) => {
      if (depth > 5 || paths.length > 64) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
          const val = v[k];
          if (typeof val === 'string' && PATH_KEY.test(k)) paths.push(val);
          else walk(val, depth + 1);
        }
      }
    };
    walk(input, 0);
    const isPlanningPath = (s) => /(^|[\\\\/])\\.planning([\\\\/]|$)/.test(s);
    if (isWrite && paths.some(isPlanningPath)) {
      return process.stdout.write(JSON.stringify({
        cancel: true,
        errorMessage:
          'GSD: .planning/ artifacts are managed by GSD workflows. Edit them only through a /gsd-* command, not directly.',
      }));
    }
  } catch { /* fall through to allow */ }
  return allow();
});
`;
}

function mergeGsdAgentsMd(filePath: string, gsdContent: string): void {
  const gsdBlock = GSD_AGENTS_MD_MARKER + '\n' + gsdContent.trim() + '\n' + GSD_AGENTS_MD_CLOSE_MARKER;

  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, gsdBlock + '\n');
    return;
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  const openIndex = existing.indexOf(GSD_AGENTS_MD_MARKER);
  const closeIndex = existing.indexOf(GSD_AGENTS_MD_CLOSE_MARKER);

  if (openIndex !== -1 && closeIndex !== -1) {
    const before = existing.substring(0, openIndex).trimEnd();
    const after = existing.substring(closeIndex + GSD_AGENTS_MD_CLOSE_MARKER.length).trimStart();
    let newContent = '';
    if (before) newContent += before + '\n\n';
    newContent += gsdBlock;
    if (after) newContent += '\n\n' + after;
    newContent += '\n';
    fs.writeFileSync(filePath, newContent);
    return;
  }

  fs.writeFileSync(filePath, existing.trimEnd() + '\n\n' + gsdBlock + '\n');
}

// ---------------------------------------------------------------------------
// writeClineArtifacts
// ---------------------------------------------------------------------------

function writeClineArtifacts(targetDir: string, isGlobalInstall: boolean): { written: string[]; configuredEntrypoints: ConfiguredEntrypoint[] } {
  const written: string[] = [];
  const configuredEntrypoints: ConfiguredEntrypoint[] = [];
  const clinerulesDir = path.join(targetDir, '.clinerules');

  try {
    if (fs.existsSync(clinerulesDir)) {
      const st = fs.lstatSync(clinerulesDir);
      if (st.isFile() || st.isSymbolicLink()) {
        fs.unlinkSync(clinerulesDir);
        console.log(`  ${green}✓${reset} Migrated legacy .clinerules to directory form`);
      }
    }
  } catch { /* best-effort migration */ }

  fs.mkdirSync(clinerulesDir, { recursive: true });
  fs.writeFileSync(path.join(clinerulesDir, 'gsd.md'), buildClineRulesBody());
  written.push('.clinerules/gsd.md');
  console.log(`  ${green}✓${reset} Wrote .clinerules/gsd.md`);

  const hooksDir = path.join(clinerulesDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'PreToolUse');
  fs.writeFileSync(hookPath, buildClinePreToolUseHook());
  try { fs.chmodSync(hookPath, 0o755); } catch { /* Windows: hooks unsupported anyway */ }
  written.push('.clinerules/hooks/PreToolUse');
  console.log(`  ${green}✓${reset} Wrote .clinerules/hooks/PreToolUse`);
  // #4249 (CodeRabbit): Cline invokes this file directly via its own
  // `#!/usr/bin/env node` shebang — a hybrid case. The script itself still
  // needs the execute bit (selfExecutable), but unlike GSD's other JS hooks
  // (which bake an absolute, install-time-resolved node path specifically to
  // avoid this) its interpreter is looked up on PATH by `env` at hook-fire
  // time, so `node` must also resolve or the hook can never run.
  configuredEntrypoints.push({
    runtime: 'cline',
    configPath: hookPath,
    scriptPath: hookPath,
    interpreterCandidates: ['node'],
    selfExecutable: true,
    platform: process.platform,
  });

  if (isGlobalInstall) {
    try {
      const agentsPath = path.join(os.homedir(), '.agents', 'AGENTS.md');
      mergeGsdAgentsMd(agentsPath, buildClineAgentsMdBody());
      console.log(`  ${green}✓${reset} Merged GSD instructions into ~/.agents/AGENTS.md`);
    } catch (err) {
      console.warn(`  ${yellow}⚠${reset} Could not write ~/.agents/AGENTS.md: ${(err as Error).message}`);
    }
  }

  return { written, configuredEntrypoints };
}

// ---------------------------------------------------------------------------
// Cursor hook functions
// ---------------------------------------------------------------------------

function buildCursorHookEntry(scriptPath: string): Record<string, unknown> {
  return {
    type: 'command',
    command: shellCmdProjection.posixNormalize(scriptPath),
    [GSD_CURSOR_HOOK_MARKER]: true,
  };
}

function isManagedCursorHookEntry(entry: unknown): boolean {
  return Boolean(entry && typeof entry === 'object' && (entry as Record<string, unknown>)[GSD_CURSOR_HOOK_MARKER]);
}

interface CursorManagedEntries {
  sessionStart?: Record<string, unknown> | null;
  postToolUse?: Record<string, unknown> | null;
  [event: string]: Record<string, unknown> | null | undefined;
}

function reconcileCursorHooksJson(hooksJsonPath: string, managedEntries: CursorManagedEntries | null): ReconcileResult {
  let parsed: Record<string, unknown> = {};
  let currentContent: string | null = null;

  if (fs.existsSync(hooksJsonPath)) {
    const raw = fs.readFileSync(hooksJsonPath, 'utf8');
    currentContent = raw;
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`Cursor hooks.json parse failed: ${err && (err as Error).message ? (err as Error).message : String(err)}`);
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};

  const hasNestedHooksObject =
    parsed['hooks'] && typeof parsed['hooks'] === 'object' && !Array.isArray(parsed['hooks']);
  if (!hasNestedHooksObject) {
    const lifted: Record<string, unknown> = {};
    for (const k of CURSOR_MANAGED_EVENTS) {
      if (Array.isArray(parsed[k])) {
        lifted[k] = parsed[k];
        delete parsed[k];
      }
    }
    parsed['hooks'] = lifted;
  }
  if (!parsed['version']) parsed['version'] = 1;
  const hookTable = parsed['hooks'] as Record<string, unknown>;

  const entries = managedEntries || {};

  for (const event of CURSOR_MANAGED_EVENTS) {
    const existing = Array.isArray(hookTable[event]) ? (hookTable[event] as unknown[]) : [];
    const userOwned = existing.filter((e) => !isManagedCursorHookEntry(e));
    const newEntry = entries[event] || null;
    if (newEntry) {
      hookTable[event] = [...userOwned, newEntry];
    } else {
      if (userOwned.length > 0) {
        hookTable[event] = userOwned;
      } else {
        delete hookTable[event];
      }
    }
  }

  const nextContent = `${JSON.stringify(parsed, null, 2)}\n`;
  const changed = currentContent !== nextContent;
  const shouldWrite = changed && (currentContent !== null || Object.keys(parsed).length > 0);
  if (shouldWrite) {
    atomicWriteFileSync(hooksJsonPath, nextContent, 'utf8');
  }

  return { changed: changed, wrote: shouldWrite, path: hooksJsonPath };
}

interface WriteCursorHooksJsonOpts {
  absoluteRunner?: string | null;
  platform?: string;
  managedHookEvents?: readonly string[];
}

/**
 * Stage the `hooks/lib/` helpers a set of staged hook scripts require, walking
 * the require graph TRANSITIVELY to a fixed point.
 *
 * Extracted from writeCursorHooksJson (#3911 review, commit 704859e9c) so the
 * reduced Codex hook bundle can share one implementation instead of growing a
 * second, divergent copy (#4087 / #4098). Both reduced bundles hand-pick which
 * hook SCRIPTS they ship, and neither can hand-pick their helpers correctly for
 * long: `hooks/lib/hook-exit.js` requires `./cli-exit.js`, which requires
 * `./exit-code-registry.js` — with NO `./lib/` prefix, because from inside
 * `lib/` the sibling is already local. A single-pass scan for the `./lib/…`
 * spelling used FROM a hook script stages hook-exit.js and stops, and the
 * installed hook then dies on MODULE_NOT_FOUND at load, before its own
 * try/catch, on every event it is registered for.
 *
 * Scans CONTENT rather than paths so a caller can seed from whatever it staged,
 * transformed or not, without this helper knowing the caller's layout.
 *
 * @returns the lib filenames actually staged, in staging order.
 */
function stageTransitiveHookLibs(opts: {
  seedSources: string[];
  srcLibDir: string;
  destLibDir: string;
  runtimeLabel: string;
  transform?: (content: string) => string;
}): string[] {
  const { seedSources, srcLibDir, destLibDir, runtimeLabel, transform } = opts;
  const requiredLibFiles = new Set<string>();
  const scannedLibFiles = new Set<string>();
  const staged: string[] = [];
  // `./X` means DIFFERENT things depending on where the scanned file lives, and
  // conflating them stages the wrong file. From a hook SCRIPT in hooks/, a bare
  // `./X` is a sibling hook-level artifact — Codex's gsd-check-update-worker.js
  // requires `./managed-hooks-registry.cjs`, which lives in hooks/, not
  // hooks/lib/ — so only the explicit `./lib/X` spelling is a lib requirement.
  // From inside a LIB file, the sibling is already local, so `./X` IS a lib
  // requirement (hook-exit.js -> ./cli-exit.js -> ./exit-code-registry.js); that
  // is the case 704859e9c added and it must keep working. Cursor never exposed
  // the difference because none of its staged scripts has a bare sibling
  // require; Codex's does, and the fail-loud guard below caught it immediately
  // by demanding managed-hooks-registry.cjs out of hooks/dist/lib.
  // Fresh per call: a module-level /g regex carries lastIndex across calls and
  // would silently skip matches on the second install in one process.
  const seedRequireRe = /require\(\s*['"]\.\/lib\/([A-Za-z0-9._-]+)['"]\s*\)/g;
  const libRequireRe = /require\(\s*['"]\.\/(?:lib\/)?([A-Za-z0-9._-]+)['"]\s*\)/g;
  // A NESTED helper path is outside the flat layout hooks/lib/ has and the
  // build emits, and the character classes above cannot express it — so it
  // would be a SILENT miss, staging nothing and shipping a hook that dies at
  // load. Detected separately and refused loudly instead: a silent miss is the
  // failure mode this whole function exists to remove (review of #4087).
  const nestedRequireRe = /require\(\s*['"]\.\/lib\/[A-Za-z0-9._-]+\/[^'"]*['"]\s*\)/;

  const scanForLibRequires = (source: string, fromLib: boolean): void => {
    if (nestedRequireRe.test(source)) {
      throw new Error(
        `A staged ${runtimeLabel} hook requires a NESTED hooks/lib path. hooks/lib/ is flat and `
        + 'this stager only resolves flat helper names, so the nested helper would never be '
        + 'staged and the hook would throw MODULE_NOT_FOUND at load. Flatten the helper or '
        + 'extend this stager deliberately.',
      );
    }
    const re = fromLib ? libRequireRe : seedRequireRe;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const candidate = m[1];
      // A capture with no alphanumeric character is not a module name — it is
      // prose. This scan reads whole file text, comments included, and
      // hooks/lib/injection-patterns.js's own header documents this mechanism
      // with the literal string `require('./lib/...')`, which captures `...`
      // and would send the resolver hunting for `hooks/lib/...` and fail the
      // install (measured; that helper is not staged for either reduced bundle
      // today, so it is latent rather than live).
      //
      // KNOWN LIMIT, disclosed rather than papered over: this does NOT make the
      // scan comment-aware. A comment naming a REAL helper — `require(
      // './lib/git-cmd.js')` in prose — still registers it and would over-stage
      // that helper. Closing that needs a comment-stripping pass; the
      // line-based stripper in scripts/lint-hooks-runtime-build-seam.cjs is the
      // precedent (its header explains why the naive two-regex strip corrupts
      // these very files), but promoting a lint-script helper into installer
      // runtime code is a larger change than this fix.
      if (!/[A-Za-z0-9]/.test(candidate)) continue;
      requiredLibFiles.add(candidate);
    }
  };

  for (const source of seedSources) scanForLibRequires(source, false);
  if (requiredLibFiles.size === 0) return staged;

  fs.mkdirSync(destLibDir, { recursive: true });
  // Iterate to a fixed point: staging a lib file can add MORE required lib
  // files (its own requires), which must themselves be staged and scanned.
  let libFile: string | undefined = [...requiredLibFiles].find((f) => !scannedLibFiles.has(f));
  while (libFile !== undefined) {
    scannedLibFiles.add(libFile);
    // Node's own extension resolution: `require('./lib/x')` is a valid, working
    // CommonJS spelling today, and matching only the extension-bearing form
    // resolved `x` literally, found nothing, and failed the install on a
    // legitimate require (review of #4087). Try the bare name first so an
    // extension-bearing capture still wins, then .js/.cjs.
    let resolvedName: string | undefined;
    for (const candidate of [libFile, `${libFile}.js`, `${libFile}.cjs`]) {
      if (fs.existsSync(path.join(srcLibDir, candidate))) { resolvedName = candidate; break; }
    }
    const libSrc = path.join(srcLibDir, resolvedName ?? libFile);
    if (resolvedName === undefined) {
      // FAIL LOUD. Skipping here would ship hook scripts whose top-level
      // require() throws before their own try/catch, wedging every session —
      // and the install would still exit 0, so nobody would know until a user
      // hit it. A missing helper source is a packaging bug; surface it.
      throw new Error(
        `hooks/lib/${libFile} is required by a staged ${runtimeLabel} hook but is missing from ${srcLibDir}. `
        + 'Installing would ship a hook that throws MODULE_NOT_FOUND at load.',
      );
    }
    let libContent = fs.readFileSync(libSrc, 'utf8');
    if (transform) libContent = transform(libContent);
    // Written under its RESOLVED name so an extensionless require still lands a
    // file Node can resolve at the destination.
    fs.writeFileSync(path.join(destLibDir, resolvedName), libContent);
    staged.push(resolvedName);
    scanForLibRequires(libContent, true);
    libFile = [...requiredLibFiles].find((f) => !scannedLibFiles.has(f));
  }
  return staged;
}

function writeCursorHooksJson(targetDir: string, src: string, opts?: WriteCursorHooksJsonOpts): { hooksJsonPath: string; changed: boolean; configuredEntrypoints: ConfiguredEntrypoint[] } {
  opts = opts || {};
  const hooksDir = path.join(targetDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  // Descriptor-driven event resolution (#2089): the managed event set comes
  // from the host descriptor's hostBehaviors.managedHookEvents via the pure
  // adapter (resolveManagedHookEvents), NOT a hardcoded constant.
  const events = resolveManagedHookEvents(opts.managedHookEvents);
  const hookScripts = resolveHookScripts(events);
  const srcHooksDir = path.join(src, 'hooks');
  const installedScripts = new Set<string>();
  for (const script of hookScripts) {
    const srcPath = path.join(srcHooksDir, script);
    const destPath = path.join(hooksDir, script);
    if (fs.existsSync(srcPath)) {
      let content = fs.readFileSync(srcPath, 'utf8');
      content = content.replace(/gsd:/gi, 'gsd-');
      fs.writeFileSync(destPath, content);
      try { fs.chmodSync(destPath, 0o755); } catch { /* Windows: ignore chmod */ }
      installedScripts.add(script);
    }
  }

  // Stage the hooks/lib/ helpers the staged scripts require (#2587), TRANSITIVELY
  // (#3911 review): a lib helper can itself require a sibling under lib/ (e.g.
  // hooks/lib/hook-exit.js requires './cli-exit.js', which requires
  // './exit-code-registry.js') — a require with NO './lib/' prefix, because from
  // inside lib/ the sibling is already local. The original single-pass scan only
  // ever matched the "./lib/…" spelling used FROM a hook script, so it staged
  // hook-exit.js but never walked hook-exit.js's own requires, and an installed
  // Cursor hook wedged on MODULE_NOT_FOUND for './cli-exit.js' at load — before
  // its own try/catch. This walks a worklist: hook scripts seed it with their
  // "./lib/X" requires, and every lib file staged is itself scanned for further
  // "./lib/X" OR bare "./X" (sibling-within-lib) requires, so the requirement
  // graph is derived to a fixed point instead of one hand-tuned level deep.
  stageTransitiveHookLibs({
    seedSources: [...installedScripts].map((script) => fs.readFileSync(path.join(hooksDir, script), 'utf8')),
    srcLibDir: path.join(srcHooksDir, 'lib'),
    destLibDir: path.join(hooksDir, 'lib'),
    runtimeLabel: 'Cursor',
    transform: (content) => content.replace(/gsd:/gi, 'gsd-'),
  });

  // #2717: write the CommonJS marker into hooks/ alongside the staged .js
  // scripts. Cursor sets skipSharedHooksInstall, so it never reaches
  // installSharedHooksBundle (the only other writer of this marker); without
  // it, a ~/.cursor/package.json declaring {"type":"module"} makes Node load
  // these require()-using scripts as ESM and every Cursor hook fails silently.
  //
  // #2544: gated on having actually staged a script, mirroring
  // installSharedHooksBundle's `stagedHooks` gate. hooks/ is shared space, and
  // this function mkdirs it unconditionally — so an ungated write drops a GSD
  // marker into a directory GSD created but did not fill, which is the same
  // write-into-someone-else's-territory this issue is about.
  if (installedScripts.size > 0) {
    ensureCommonJsMarker(hooksDir);
  }

  const configuredEntrypoints: ConfiguredEntrypoint[] = [];
  const hookOpts: BuildHookCommandOpts = {
    runtime: 'cursor',
    platform: opts.platform || process.platform,
    configPath: path.join(targetDir, 'hooks.json'),
    configuredEntrypoints,
  };
  const commands: Record<string, string | null> = {};
  for (const ev of events) {
    const script = CURSOR_EVENT_SCRIPT_MAP[ev];
    if (script && installedScripts.has(script)) {
      commands[ev] = buildHookCommand(targetDir, script, hookOpts);
    } else {
      commands[ev] = null;
    }
  }
  const managedEntries = buildHookBusEntries(events, commands) as CursorManagedEntries;

  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  const result = reconcileCursorHooksJson(hooksJsonPath, managedEntries);
  return { hooksJsonPath, changed: result.changed, configuredEntrypoints };
}

function removeCursorHooksJson(targetDir: string): { changed: boolean } {
  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  if (!fs.existsSync(hooksJsonPath)) return { changed: false };
  const result = reconcileCursorHooksJson(hooksJsonPath, null);
  if (result.changed) {
    try {
      const contentRaw = fs.readFileSync(hooksJsonPath, 'utf8');
      const parsed = JSON.parse(contentRaw) as Record<string, unknown>;
      const hookTable = (parsed['hooks'] && typeof parsed['hooks'] === 'object' && !Array.isArray(parsed['hooks']))
        ? (parsed['hooks'] as Record<string, unknown>)
        : {};
      const hasAnyEvents = Object.keys(hookTable).some(
        (k) => Array.isArray(hookTable[k]) && (hookTable[k] as unknown[]).length > 0,
      );
      if (!hasAnyEvents) {
        fs.unlinkSync(hooksJsonPath);
        // #2717: also remove the CommonJS marker GSD wrote into hooks/ — but
        // only if it still carries GSD's exact content (a user-authored
        // package.json is never deleted). Best-effort: a failure here must not
        // mask the hooks.json removal above.
        try { removeCommonJsMarkerIfGsdOwned(path.join(targetDir, 'hooks')); } catch { /* leave it */ }
        return { changed: true };
      }
    } catch { /* best-effort: leave the file */ }
  }
  return { changed: result.changed };
}

// ---------------------------------------------------------------------------
// Windsurf/Cascade hook functions (ADR-1239 / #2100 Stage 2 — HOOK-BRIDGE)
//
// Cascade (Windsurf's agent) hooks.json format is DISTINCT from Cursor's:
//   { "hooks": { "<event>": [ { "command": "<shell cmd>", ... } ] } }
// Each entry carries a bare `command` STRING (a shell command line) — not
// Cursor's `{ type: 'command', command: <cmd> }` wrapper — and there is no
// top-level `version` field. Docs (reference): https://docs.windsurf.com/llms-full.txt ,
// https://docs.devin.ai/desktop/cascade/hooks
//
// Cascade blocks via EXIT CODE 2 (+ a stderr reason), not Cursor's stdout-JSON
// `{ block: true, reason }` form — so the two hook scripts installed here
// (hooks/gsd-windsurf-pre-write.js, hooks/gsd-windsurf-pre-command.js) speak a
// different protocol than the Cursor scripts, even though the surrounding
// install/reconcile infra mirrors writeCursorHooksJson/removeCursorHooksJson.
//
// Only 2 of GSD's 6 Cursor-parity hook events have a Cascade counterpart with
// BLOCKING semantics: pre_write_code and pre_run_command. Cascade has no
// context-injection channel (no `additional_context`-style advisory
// response), so the 4 advisory events GSD registers on Cursor (sessionStart,
// postToolUse, stop, subagentStart/subagentStop) are deliberately NOT ported.
// ---------------------------------------------------------------------------

const GSD_WINDSURF_PRE_WRITE_HOOK_SCRIPT = 'gsd-windsurf-pre-write.js';
const GSD_WINDSURF_PRE_COMMAND_HOOK_SCRIPT = 'gsd-windsurf-pre-command.js';
const GSD_WINDSURF_HOOK_MARKER = 'gsd-managed';

/** The 2 Cascade hook events GSD wires with blocking (exit-code-2) guards. */
const WINDSURF_HOOK_EVENTS = Object.freeze(['pre_write_code', 'pre_run_command'] as const);

/** Event → hook-script mapping (mirrors CURSOR_EVENT_SCRIPT_MAP's convention). */
const WINDSURF_EVENT_SCRIPT_MAP: Readonly<Record<string, string>> = Object.freeze({
  pre_write_code: GSD_WINDSURF_PRE_WRITE_HOOK_SCRIPT,
  pre_run_command: GSD_WINDSURF_PRE_COMMAND_HOOK_SCRIPT,
});

/** All GSD-managed Windsurf hook scripts (used by uninstall cleanup). */
const GSD_WINDSURF_HOOK_SCRIPTS = [
  GSD_WINDSURF_PRE_WRITE_HOOK_SCRIPT,
  GSD_WINDSURF_PRE_COMMAND_HOOK_SCRIPT,
];

/**
 * Build a single Cascade hooks.json managed entry. Cascade's entry shape has
 * no `type` field (unlike Cursor's `{ type: 'command', command }`) — just a
 * bare `command` shell string plus the GSD marker.
 */
function buildWindsurfHookEntry(command: string): Record<string, unknown> {
  return {
    command,
    [GSD_WINDSURF_HOOK_MARKER]: true,
  };
}

function isManagedWindsurfHookEntry(entry: unknown): boolean {
  return Boolean(entry && typeof entry === 'object' && (entry as Record<string, unknown>)[GSD_WINDSURF_HOOK_MARKER]);
}

interface WindsurfManagedEntries {
  pre_write_code?: Record<string, unknown> | null;
  pre_run_command?: Record<string, unknown> | null;
  [event: string]: Record<string, unknown> | null | undefined;
}

/**
 * Reconcile GSD's managed Cascade hook entries into `<targetDir>/hooks.json`,
 * preserving any user-owned entries. Mirrors reconcileCursorHooksJson's
 * merge/no-write-when-unchanged semantics, adapted to Cascade's flatter
 * `{ hooks: { <event>: [...] } }` shape (no `version` field, no legacy
 * top-level-array lift — Cascade's hooks.json is a brand-new surface with no
 * prior shape to migrate from).
 */
function reconcileWindsurfHooksJson(hooksJsonPath: string, managedEntries: WindsurfManagedEntries | null): ReconcileResult {
  let parsed: Record<string, unknown> = {};
  let currentContent: string | null = null;

  if (fs.existsSync(hooksJsonPath)) {
    const raw = fs.readFileSync(hooksJsonPath, 'utf8');
    currentContent = raw;
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`Windsurf hooks.json parse failed: ${err && (err as Error).message ? (err as Error).message : String(err)}`);
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};

  const hasNestedHooksObject =
    parsed['hooks'] && typeof parsed['hooks'] === 'object' && !Array.isArray(parsed['hooks']);
  if (!hasNestedHooksObject) parsed['hooks'] = {};
  const hookTable = parsed['hooks'] as Record<string, unknown>;

  const entries = managedEntries || {};

  for (const event of WINDSURF_HOOK_EVENTS) {
    const existing = Array.isArray(hookTable[event]) ? (hookTable[event] as unknown[]) : [];
    const userOwned = existing.filter((e) => !isManagedWindsurfHookEntry(e));
    const newEntry = entries[event] || null;
    if (newEntry) {
      hookTable[event] = [...userOwned, newEntry];
    } else if (userOwned.length > 0) {
      hookTable[event] = userOwned;
    } else {
      delete hookTable[event];
    }
  }

  // Avoid writing an empty `{ "hooks": {} }` artifact.
  if (Object.keys(hookTable).length === 0) delete parsed['hooks'];

  const nextContent = `${JSON.stringify(parsed, null, 2)}\n`;
  const changed = currentContent !== nextContent;
  const shouldWrite = changed && (currentContent !== null || Object.keys(parsed).length > 0);
  if (shouldWrite) {
    atomicWriteFileSync(hooksJsonPath, nextContent, 'utf8');
  }

  return { changed: changed, wrote: shouldWrite, path: hooksJsonPath };
}

interface WriteWindsurfHooksJsonOpts {
  platform?: string;
}

/**
 * Write GSD-managed Cascade lifecycle hooks into `<targetDir>/hooks.json`.
 * Both managed hook scripts (gsd-windsurf-pre-write.js,
 * gsd-windsurf-pre-command.js) are copied from the GSD hooks/ source to
 * `<targetDir>/hooks/` first, so the hooks.json entries never reference a
 * script that wasn't installed. Mirrors writeCursorHooksJson's structure;
 * `buildHookCommand` is runtime-agnostic (it already returns a plain shell
 * command string), so it is reused as-is with `runtime: 'windsurf'` — only
 * the hooks.json ENTRY shape (buildWindsurfHookEntry) and the reconcile
 * function differ from Cursor's.
 *
 * @param targetDir - The Windsurf config dir (global: ~/.codeium/windsurf; local: .windsurf)
 * @param src       - The GSD install source root (for copying hook scripts)
 * @param opts      - `{ platform? }`
 * @returns `{ hooksJsonPath, changed }`
 */
function writeWindsurfHooksJson(targetDir: string, src: string, opts?: WriteWindsurfHooksJsonOpts): { hooksJsonPath: string; changed: boolean; configuredEntrypoints: ConfiguredEntrypoint[] } {
  opts = opts || {};
  const hooksDir = path.join(targetDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const srcHooksDir = path.join(src, 'hooks');
  const installedScripts = new Set<string>();
  for (const script of GSD_WINDSURF_HOOK_SCRIPTS) {
    const srcPath = path.join(srcHooksDir, script);
    const destPath = path.join(hooksDir, script);
    if (fs.existsSync(srcPath)) {
      let content = fs.readFileSync(srcPath, 'utf8');
      content = content.replace(/gsd:/gi, 'gsd-');
      fs.writeFileSync(destPath, content);
      try { fs.chmodSync(destPath, 0o755); } catch { /* Windows: ignore chmod */ }
      installedScripts.add(script);
    }
  }

  // Stage the hooks/lib/ helpers these scripts require (#4087 review). Windsurf
  // sets hostBehaviors.skipSharedHooksInstall, so like Cursor it never reaches
  // installSharedHooksBundle — the only other stager of hooks/lib — and it was
  // staging neither. Both Cascade guards require helpers at module load:
  // gsd-windsurf-pre-write.js requires ./lib/hook-exit.js and ./lib/git-probe.js,
  // gsd-windsurf-pre-command.js requires ./lib/hook-exit.js. Measured against a
  // real `--windsurf --global` install before this call existed: the installer
  // exited 0, hooks/ held only the two scripts, and running either one exited 1
  // with "Cannot find module './lib/hook-exit.js'" — the same failure #4087
  // reports for Codex, on every pre_write_code / pre_run_command event.
  //
  // The transform matches the one applied to the scripts above: a helper must be
  // rewritten the same way as its caller or the two disagree on the spelling.
  stageTransitiveHookLibs({
    seedSources: [...installedScripts].map((script) => fs.readFileSync(path.join(hooksDir, script), 'utf8')),
    srcLibDir: path.join(srcHooksDir, 'lib'),
    destLibDir: path.join(hooksDir, 'lib'),
    runtimeLabel: 'Windsurf',
    transform: (content) => content.replace(/gsd:/gi, 'gsd-'),
  });

  // #2717: write the CommonJS marker into hooks/ alongside the staged .js
  // scripts. Windsurf sets skipSharedHooksInstall, so it never reaches
  // installSharedHooksBundle (the only other writer of this marker); without
  // it, a config-root package.json declaring {"type":"module"} makes Node load
  // these require()-using scripts as ESM and the Windsurf hooks fail silently.
  //
  // #2544: gated on having actually staged a script — see the identical gate in
  // the Cursor writer above and `stagedHooks` in installSharedHooksBundle.
  if (installedScripts.size > 0) {
    ensureCommonJsMarker(hooksDir);
  }

  const configuredEntrypoints: ConfiguredEntrypoint[] = [];
  const hookOpts: BuildHookCommandOpts = {
    runtime: 'windsurf',
    platform: opts.platform || process.platform,
    configPath: path.join(targetDir, 'hooks.json'),
    configuredEntrypoints,
  };
  const commands: Record<string, string | null> = {};
  for (const ev of WINDSURF_HOOK_EVENTS) {
    const script = WINDSURF_EVENT_SCRIPT_MAP[ev];
    commands[ev] = (script && installedScripts.has(script)) ? buildHookCommand(targetDir, script, hookOpts) : null;
  }

  const managedEntries: WindsurfManagedEntries = {};
  for (const ev of WINDSURF_HOOK_EVENTS) {
    const cmd = commands[ev];
    if (cmd) managedEntries[ev] = buildWindsurfHookEntry(cmd);
  }

  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  const result = reconcileWindsurfHooksJson(hooksJsonPath, managedEntries);
  return { hooksJsonPath, changed: result.changed, configuredEntrypoints };
}

/**
 * Remove all GSD-managed Cascade hook entries from hooks.json. User-owned
 * entries are preserved. If the file becomes empty, it is removed.
 *
 * @param targetDir - The Windsurf config dir
 * @returns `{ changed }`
 */
function removeWindsurfHooksJson(targetDir: string): { changed: boolean } {
  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  if (!fs.existsSync(hooksJsonPath)) return { changed: false };
  const result = reconcileWindsurfHooksJson(hooksJsonPath, null);
  if (result.changed) {
    try {
      const contentRaw = fs.readFileSync(hooksJsonPath, 'utf8');
      const parsed = JSON.parse(contentRaw) as Record<string, unknown>;
      const hookTable = (parsed['hooks'] && typeof parsed['hooks'] === 'object' && !Array.isArray(parsed['hooks']))
        ? (parsed['hooks'] as Record<string, unknown>)
        : {};
      const hasAnyEvents = Object.keys(hookTable).some(
        (k) => Array.isArray(hookTable[k]) && (hookTable[k] as unknown[]).length > 0,
      );
      if (!hasAnyEvents) {
        fs.unlinkSync(hooksJsonPath);
        // #2717: also remove the CommonJS marker GSD wrote into hooks/ — but
        // only if it still carries GSD's exact content (a user-authored
        // package.json is never deleted). Best-effort.
        try { removeCommonJsMarkerIfGsdOwned(path.join(targetDir, 'hooks')); } catch { /* leave it */ }
        return { changed: true };
      }
    } catch { /* best-effort: leave the file */ }
  }
  return { changed: result.changed };
}

// ---------------------------------------------------------------------------
// Copilot hook functions
// ---------------------------------------------------------------------------

function buildCopilotHookConfig(): Record<string, unknown> {
  return {
    version: 1,
    hooks: {
      sessionStart: [
        {
          type: 'command',
          bash: GSD_COPILOT_SESSION_HOOK_BASH,
          powershell: GSD_COPILOT_SESSION_HOOK_PWSH,
          timeoutSec: 10,
        },
      ],
      // #2099 UPGRADE 1: multi-event hook bus — preToolUse (worktree/read-safety
      // advisory), postToolUse (context-monitor advisory), userPromptSubmitted
      // (prompt-guard advisory), sessionEnd (session-finalize advisory).
      preToolUse: [
        {
          type: 'command',
          bash: GSD_COPILOT_PRE_TOOL_HOOK_BASH,
          powershell: GSD_COPILOT_PRE_TOOL_HOOK_PWSH,
          timeoutSec: 10,
        },
      ],
      postToolUse: [
        {
          type: 'command',
          bash: GSD_COPILOT_POST_TOOL_HOOK_BASH,
          powershell: GSD_COPILOT_POST_TOOL_HOOK_PWSH,
          timeoutSec: 10,
        },
      ],
      userPromptSubmitted: [
        {
          type: 'command',
          bash: GSD_COPILOT_PROMPT_SUBMIT_HOOK_BASH,
          powershell: GSD_COPILOT_PROMPT_SUBMIT_HOOK_PWSH,
          timeoutSec: 10,
        },
      ],
      sessionEnd: [
        {
          type: 'command',
          bash: GSD_COPILOT_SESSION_END_HOOK_BASH,
          powershell: GSD_COPILOT_SESSION_END_HOOK_PWSH,
          timeoutSec: 10,
        },
      ],
    },
  };
}

function writeCopilotHookConfig(targetDir: string): string {
  const hooksDir = path.join(targetDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, GSD_COPILOT_HOOK_FILE);
  fs.writeFileSync(hookPath, JSON.stringify(buildCopilotHookConfig(), null, 2) + '\n');
  return hookPath;
}

// ---------------------------------------------------------------------------
// applySettingsJsonHooks
//
// MUTATES `settings` by reference — registers all GSD-managed hook entries
// into settings.hooks.* for runtimes that use a settings.json hook surface
// (Claude Code, Antigravity, Qwen Code, and others).
// Skipped entirely for runtimes whose hooksSurface descriptor field is 'none'
// (opencode and kilo, which have their own hook surface).
//
// Extracted from the `if (!isOpencode && !isKilo) { … }` block inside
// install() (ADR-857 phase 5f-1b).  The hook-skip guard is now descriptor-driven
// (ADR-857 phase 5g drive 3): pass opts.hooksSurface from the runtime descriptor
// instead of deriving isOpencode/isKilo from the runtime name.
//
// @param settings  - The settings object already read from disk. Mutated in place.
// @param opts      - Closure values the block read from install()'s scope.
//   runtime                   - runtime ID string (e.g. 'claude', 'antigravity', 'qwen')
//   hooksSurface              - descriptor hooksSurface field ('settings-json'|'none'|…); if !== 'none', hooks are written
//   isGlobal                  - true for global installs
//   targetDir                 - absolute path to the runtime config dir
//   postToolEvent             - 'PostToolUse' | 'AfterTool' (pre-computed by caller from descriptor)
//   hookEvents                - registry hookEvents dialect ('gemini'|'claude'|undefined)
//   updateCheckCommand        - command string or null
//   contextMonitorCommand     - command string or null
//   promptGuardCommand        - command string or null
//   readGuardCommand          - command string or null
//   readInjectionScannerCommand - command string or null
//   configReloadCommand       - command string or null
//   hookOpts                  - { portableHooks, runtime } passed to buildHookCommand
//   localCmd                  - (hookFile: string) => string|null
//   localShellCmd             - (hookFile: string) => string|null
// ---------------------------------------------------------------------------

interface ApplySettingsJsonHooksOpts {
  runtime: string;
  isGlobal: boolean;
  targetDir: string;
  postToolEvent: string;
  /** ADR-857 phase 5f-2: hookEvents dialect from the registry descriptor ('gemini'|'claude'|undefined). */
  hookEvents?: string;
  /** ADR-857 phase 5f-3: extended hook event names from the registry descriptor. */
  extendedHookEvents?: string[];
  /** ADR-857 phase 5g drive 3: hooksSurface from the runtime descriptor ('settings-json'|'none'|…). */
  hooksSurface?: string;
  updateCheckCommand: string | null;
  contextMonitorCommand: string | null;
  promptGuardCommand: string | null;
  readGuardCommand: string | null;
  readInjectionScannerCommand: string | null;
  configReloadCommand: string | null;
  hookOpts: BuildHookCommandOpts;
  localCmd: (hookFile: string) => string | null;
  localShellCmd: (hookFile: string) => string | null;
}

// ---------------------------------------------------------------------------
// The settings-json hook registration tables (#5207, ADR-5057 §5).
//
// Hook registration inside the `settings-json` hooksSurface adapter is data:
// one row per managed hook, consumed by ONE loop (applySettingsJsonHookTables).
// A hook is added by adding a row; there is no per-hook branch to copy. Rows
// are listed in registration order — SessionStart / post-tool / pre-tool event
// arrays are created, and entries pushed, in this order, which is observable
// in the settings.json users diff.
// ---------------------------------------------------------------------------

type SettingsJsonHookEvent = 'SessionStart' | 'post' | 'pre';

type SettingsJsonCommandKey =
  | 'updateCheckCommand'
  | 'contextMonitorCommand'
  | 'promptGuardCommand'
  | 'readGuardCommand'
  | 'readInjectionScannerCommand'
  | 'configReloadCommand';

interface SettingsJsonHookRow {
  /** Hook script basename under <targetDir>/hooks/; its extension-less stem is what `referencesHook` matches. */
  readonly file: string;
  /** `post`/`pre` resolve to the descriptor's PostToolUse/AfterTool and PreToolUse/BeforeTool dialect. */
  readonly event: SettingsJsonHookEvent;
  readonly matcher?: string;
  /** Seconds, or 'blocking' for BLOCKING_GUARD_TIMEOUT_S (#3981). Omitted → no timeout key. */
  readonly timeout?: number | 'blocking';
  /** `opts`: a command the caller pre-built; `build`: built here (global → buildHookCommand, local → localCmd / localShellCmd). */
  readonly command: { readonly opts: SettingsJsonCommandKey } | { readonly build: 'js' | 'sh' };
  readonly configuredMessage: string;
  readonly skipLabel: string;
  /** What to do when the hook is already registered. */
  readonly onPresent?: { readonly kind: 'migrate-matcher-timeout' | 'repair-matcher'; readonly message: string };
  /** Warning appended after "Skipped <label> —" when the file exists but no command could be built. */
  readonly noCommandMessage?: string;
}

interface SettingsJsonExtendedRow {
  readonly event: string;
  readonly file: string;
  readonly command: { readonly opts: SettingsJsonCommandKey };
  readonly matcher?: string;
  readonly timeout: number;
  readonly configuredMessage: string;
  /** Append "(<runtime capability title>)" to the configured message. */
  readonly runtimeLabelSuffix?: boolean;
  readonly noCommandMessage?: string;
}

interface SettingsJsonHookTables {
  readonly rows: readonly SettingsJsonHookRow[];
  readonly extendedRows: readonly SettingsJsonExtendedRow[];
}

const BASH_UNAVAILABLE_MESSAGE = 'Bash executable path unavailable (#3393)';

// The tables are exported as a contract; freeze every row (and its nested
// objects) so no consumer can mutate a matcher or timeout at runtime.
function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') deepFreeze(child as object);
  }
  return Object.freeze(value);
}

const SETTINGS_JSON_HOOK_ROWS: readonly SettingsJsonHookRow[] = deepFreeze([
  // Guard: only register if the hook file was actually installed (#1754, #1817).
  { file: 'gsd-check-update.js', event: 'SessionStart', command: { opts: 'updateCheckCommand' },
    configuredMessage: 'Configured update check hook', skipLabel: 'update check hook' },
  { file: 'gsd-context-monitor.js', event: 'post', matcher: 'Bash|Edit|Write|MultiEdit|Agent|Task', timeout: 10,
    command: { opts: 'contextMonitorCommand' },
    configuredMessage: 'Configured context window monitor hook', skipLabel: 'context monitor hook',
    onPresent: { kind: 'migrate-matcher-timeout', message: 'Updated context monitor hook (added matcher + timeout)' } },
  { file: 'gsd-prompt-guard.js', event: 'pre', matcher: 'Write|Edit', timeout: 'blocking',
    command: { opts: 'promptGuardCommand' },
    configuredMessage: 'Configured prompt injection guard hook', skipLabel: 'prompt guard hook' },
  // Read-before-edit guidance (#1628): advisory-only, does not block.
  { file: 'gsd-read-guard.js', event: 'pre', matcher: 'Write|Edit', timeout: 5,
    command: { opts: 'readGuardCommand' },
    configuredMessage: 'Configured read-before-edit guard hook', skipLabel: 'read guard hook' },
  // Read-time prompt injection scanning (#2201).
  { file: 'gsd-read-injection-scanner.js', event: 'post', matcher: 'Read', timeout: 5,
    command: { opts: 'readInjectionScannerCommand' },
    configuredMessage: 'Configured read injection scanner hook', skipLabel: 'read injection scanner hook' },
  // Community hooks — registered on install but opt-in at runtime via .planning/config.json.
  { file: 'gsd-workflow-guard.js', event: 'pre', matcher: 'Bash|Edit|Write|MultiEdit', timeout: 'blocking',
    command: { build: 'js' },
    configuredMessage: 'Configured workflow guard hook (opt-in via hooks.workflow_guard)', skipLabel: 'workflow guard hook',
    onPresent: { kind: 'repair-matcher', message: 'Updated workflow guard hook matcher' } },
  // Worktree absolute-path safety (#260).
  { file: 'gsd-worktree-path-guard.js', event: 'pre', matcher: 'Write|Edit|MultiEdit', timeout: 'blocking',
    command: { build: 'js' },
    configuredMessage: 'Configured worktree path guard hook', skipLabel: 'worktree path guard hook' },
  // Agent-dispatch isolation (#3045); matcher widened to Agent|Task (#3045 MAJOR 1).
  { file: 'gsd-agent-isolation-guard.js', event: 'pre', matcher: 'Agent|Task', timeout: 'blocking',
    command: { build: 'js' },
    configuredMessage: 'Configured agent isolation dispatch guard hook', skipLabel: 'agent isolation guard hook' },
  // Catastrophic-shrink protection (#2255, fix 3 of #973).
  { file: 'gsd-write-guard.js', event: 'pre', matcher: 'Write', timeout: 'blocking',
    command: { build: 'js' },
    configuredMessage: 'Configured write guard hook (catastrophic-shrink protection)', skipLabel: 'write guard hook' },
  // Secret-file read protection (#4221).
  { file: 'gsd-secret-read-guard.js', event: 'pre', matcher: 'Read|Grep|Bash', timeout: 'blocking',
    command: { build: 'js' },
    configuredMessage: 'Configured secret read guard hook (.env / .secrets read protection)', skipLabel: 'secret read guard hook' },
  // The four `.sh` rows: their built commands also feed the #3329 reconcile.
  { file: 'gsd-validate-commit.sh', event: 'pre', matcher: 'Bash', timeout: 'blocking',
    command: { build: 'sh' },
    configuredMessage: 'Configured commit validation hook (opt-in via config)', skipLabel: 'commit validation hook',
    noCommandMessage: BASH_UNAVAILABLE_MESSAGE },
  { file: 'gsd-graphify-update.sh', event: 'post', matcher: 'Bash', timeout: 5,
    command: { build: 'sh' },
    configuredMessage: 'Configured graphify auto-update hook (opt-in via graphify.auto_update)', skipLabel: 'graphify auto-update hook',
    noCommandMessage: BASH_UNAVAILABLE_MESSAGE },
  { file: 'gsd-session-state.sh', event: 'SessionStart',
    command: { build: 'sh' },
    configuredMessage: 'Configured session state orientation hook (opt-in via config)', skipLabel: 'session state hook',
    noCommandMessage: BASH_UNAVAILABLE_MESSAGE },
  { file: 'gsd-phase-boundary.sh', event: 'post', matcher: 'Write|Edit', timeout: 5,
    command: { build: 'sh' },
    configuredMessage: 'Configured phase boundary detection hook (opt-in via config)', skipLabel: 'phase boundary hook',
    noCommandMessage: BASH_UNAVAILABLE_MESSAGE },
]);

// Extended lifecycle events are descriptor-gated (`extendedHookEvents`): a row
// registers only for runtimes whose descriptor lists its event. SubagentStart
// is qwen/codebuddy-only today; the Before/After Agent/Model rows are an inert
// seam (no runtime declares them) that re-activates if one does (#776, #1928).
// FileChanged hot-reloads the gsd config on .planning/config.json edits.
function contextMonitorRow(event: string, runtimeLabelSuffix: boolean): SettingsJsonExtendedRow {
  return {
    event,
    file: 'gsd-context-monitor.js',
    command: { opts: 'contextMonitorCommand' },
    timeout: 10,
    configuredMessage: `Configured ${event} context monitor hook`,
    ...(runtimeLabelSuffix ? { runtimeLabelSuffix } : {}),
  };
}

const SETTINGS_JSON_EXTENDED_ROWS: readonly SettingsJsonExtendedRow[] = deepFreeze([
  contextMonitorRow('SubagentStop', true),
  contextMonitorRow('Stop', true),
  contextMonitorRow('PreCompact', true),
  contextMonitorRow('SubagentStart', true),
  contextMonitorRow('BeforeAgent', false),
  contextMonitorRow('AfterAgent', false),
  contextMonitorRow('BeforeModel', false),
  { event: 'FileChanged', file: 'gsd-config-reload.js', command: { opts: 'configReloadCommand' }, matcher: 'config.json', timeout: 8,
    configuredMessage: 'Configured FileChanged config-reload hook (Claude Code)',
    noCommandMessage: 'Node executable path unavailable' },
]);

function hookStem(file: string): string {
  return file.replace(/\.(?:js|sh)$/, '');
}

/* eslint-disable @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/no-unsafe-call,
                  @typescript-eslint/no-unsafe-assignment,
                  @typescript-eslint/no-explicit-any */
function groupReferencesHook(entry: any, stem: string): boolean {
  return Boolean(entry.hooks && entry.hooks.some((h: HookEntry) => referencesHook(h as Record<string, unknown>, stem)));
}

function resolveRowTimeout(timeout: number | 'blocking' | undefined): number | undefined {
  return timeout === 'blocking' ? BLOCKING_GUARD_TIMEOUT_S : timeout;
}

function resolveRowCommand(row: SettingsJsonHookRow, opts: ApplySettingsJsonHooksOpts): string | null {
  if ('opts' in row.command) return opts[row.command.opts];
  if (opts.isGlobal) return buildHookCommand(opts.targetDir, row.file, opts.hookOpts);
  return row.command.build === 'sh' ? opts.localShellCmd(row.file) : opts.localCmd(row.file);
}

function reconcilePresentHook(row: SettingsJsonHookRow, entries: any[], existing: any): void {
  const present = row.onPresent;
  if (!present) return;
  if (present.kind === 'repair-matcher') {
    if (existing.matcher !== row.matcher) {
      existing.matcher = row.matcher;
      console.log(`  ${green}✓${reset} ${present.message}`);
    }
    return;
  }
  // migrate-matcher-timeout: add the matcher and timeout an older installer omitted.
  const stem = hookStem(row.file);
  const timeout = resolveRowTimeout(row.timeout);
  for (const entry of entries) {
    if (!groupReferencesHook(entry, stem)) continue;
    let migrated = false;
    if (!entry.matcher) {
      entry.matcher = row.matcher;
      migrated = true;
    }
    for (const h of entry.hooks) {
      if (referencesHook(h as Record<string, unknown>, stem) && !h.timeout) {
        h.timeout = timeout;
        migrated = true;
      }
    }
    if (migrated) console.log(`  ${green}✓${reset} ${present.message}`);
  }
}

function pushHookGroup(entries: any[], matcher: string | undefined, command: string, timeout: number | undefined): void {
  const hook: Record<string, unknown> = { type: 'command', command };
  if (timeout !== undefined) hook['timeout'] = timeout;
  entries.push(matcher === undefined ? { hooks: [hook] } : { matcher, hooks: [hook] });
}

function applySettingsJsonHookTables(settings: any, opts: ApplySettingsJsonHooksOpts, tables: SettingsJsonHookTables): void {
  const { runtime, postToolEvent, hookEvents, extendedHookEvents, hooksSurface, targetDir, hookOpts } = opts;

  // ADR-857 phase 5f-3: extended hook events are driven by the registry
  // descriptor field rather than hardcoded runtime-name checks.
  const extendedEvents = Array.isArray(extendedHookEvents) ? extendedHookEvents : [];

  // ADR-857 phase 5g drive 3: hook-skip guard is driven by the hooksSurface
  // descriptor field. Only runtimes with hooksSurface === 'settings-json'
  // register settings.json hooks; 'none' (opencode, kilo) is skipped.
  // #2095: kimi's hooksSurface is 'kimi-hooks-toml' — it registers hooks into
  // its own native config.toml via writeKimiHooksToml and never writes
  // settings.json, so this guard must skip it too, or the console would log
  // "Configured ..." for a settings object finishInstall() never persists.
  if (hooksSurface === 'none' || hooksSurface === 'kimi-hooks-toml') return;

  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!settings.hooks.SessionStart) {
    settings.hooks.SessionStart = [];
  }

  // #3981: raise existing managed blocking-guard entries still on the old
  // 5 s budget to BLOCKING_GUARD_TIMEOUT_S (module-level; rationale there).
  for (const entries of Object.values(settings.hooks as Record<string, HookGroup[]>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (
          BLOCKING_GUARD_NAMES.some((name) => referencesHook(h as Record<string, unknown>, name)) &&
          h.timeout === 5
        ) {
          h.timeout = BLOCKING_GUARD_TIMEOUT_S;
        }
      }
    }
  }

  // hookEvents='gemini' → BeforeTool/AfterTool; all others → PreToolUse/PostToolUse.
  const preToolEvent = hookEvents === 'gemini' ? 'BeforeTool' : 'PreToolUse';
  const eventKey = (event: SettingsJsonHookEvent): string =>
    event === 'SessionStart' ? 'SessionStart' : event === 'post' ? postToolEvent : preToolEvent;

  // Built `.sh` commands, in row order, feed the #3329 reconcile below.
  const shellCommands: Record<string, string | null> = {};

  for (const row of tables.rows) {
    const key = eventKey(row.event);
    if (!settings.hooks[key]) {
      settings.hooks[key] = [];
    }
    const entries: any[] = settings.hooks[key];
    const command = resolveRowCommand(row, opts);
    if ('build' in row.command && row.command.build === 'sh') shellCommands[row.file] = command;

    const stem = hookStem(row.file);
    const existing = entries.find((entry) => groupReferencesHook(entry, stem));
    if (existing) {
      reconcilePresentHook(row, entries, existing);
      continue;
    }
    if (!fs.existsSync(path.join(targetDir, 'hooks', row.file))) {
      console.warn(`  ${yellow}⚠${reset}  Skipped ${row.skipLabel} — ${row.file} not found at target`);
    } else if (command) {
      pushHookGroup(entries, row.matcher, command, resolveRowTimeout(row.timeout));
      console.log(`  ${green}✓${reset} ${row.configuredMessage}`);
    } else if (row.noCommandMessage) {
      console.warn(`  ${yellow}⚠${reset}  Skipped ${row.skipLabel} — ${row.noCommandMessage}`);
    }
  }

  // #3329: `.sh` rows register only-if-absent, so an entry registered by an
  // older installer keeps its old command forever — /gsd-update (which
  // re-invokes the installer) never re-derived it. On Claude/win32 that left
  // the pre-#580/#3393 bash-runner-prefixed commands in settings.json
  // indefinitely. Reconcile existing managed `.sh` entries to the command this
  // install would generate today. Inert wherever the bash runner is still the
  // correct shape; scoped to exact managed basenames so user-authored hooks
  // are never touched.
  if (reconcileManagedShellHookCommands(settings as Settings, shellCommands, { platform: hookOpts.platform, runtime })) {
    console.log(`  ${green}✓${reset} Reconciled managed .sh hook commands to current format (#3329)`);
  }

  // Descriptor-driven (ADR-1239 / #2092): the runtime's capability title.
  const runtimeLabel = _capabilityTitle(runtime);
  for (const row of tables.extendedRows) {
    if (!extendedEvents.includes(row.event)) continue;
    if (!Array.isArray(settings.hooks[row.event])) {
      settings.hooks[row.event] = [];
    }
    const entries: any[] = settings.hooks[row.event];
    if (entries.some((entry) => groupReferencesHook(entry, hookStem(row.file)))) continue;
    const command = opts[row.command.opts];
    if (!fs.existsSync(path.join(targetDir, 'hooks', row.file))) {
      console.warn(`  ${yellow}⚠${reset}  Skipped ${row.event} hook — ${row.file} not found at target`);
    } else if (command) {
      pushHookGroup(entries, row.matcher, command, row.timeout);
      console.log(`  ${green}✓${reset} ${row.configuredMessage}${row.runtimeLabelSuffix ? ` (${runtimeLabel})` : ''}`);
    } else if (row.noCommandMessage) {
      console.warn(`  ${yellow}⚠${reset}  Skipped ${row.event} hook — ${row.noCommandMessage}`);
    }
  }
}

function applySettingsJsonHooks(settings: any, opts: ApplySettingsJsonHooksOpts): void {
  applySettingsJsonHookTables(settings, opts, { rows: SETTINGS_JSON_HOOK_ROWS, extendedRows: SETTINGS_JSON_EXTENDED_ROWS });
}
/* eslint-enable @typescript-eslint/no-unsafe-member-access,
                 @typescript-eslint/no-unsafe-call,
                 @typescript-eslint/no-unsafe-assignment,
                 @typescript-eslint/no-explicit-any */


// ---------------------------------------------------------------------------
// Kimi hooks.toml (#2095 EoS/kimi Upgrade 1 — native hook bus)
//
// Kimi CLI reads lifecycle hooks from a flat `[[hooks]]` array in its own
// config.toml (moonshotai.github.io/kimi-cli/en/customization/hooks.html),
// not from settings.json. Unlike every other hooksSurface writer above, this
// file lives OUTSIDE the runtime's GSD configDir: kimi's configDir is the
// generic Agent-Skills root (~/.config/agents by default), while config.toml
// is a sibling at ~/.kimi (KIMI_SHARE_DIR override), resolved by
// resolveKimiHooksTomlDir in runtime-homes.cts. Callers resolve that path and
// pass it in explicitly — this module never reaches into runtime-homes.cjs
// itself, keeping the same configDir/targetDir-passed-in shape every other
// writer in this file uses.
//
// GSD-owned [[hooks]] entries are wrapped in marker comments so a reinstall
// can find-and-replace only GSD's own block, leaving any user-authored
// [[hooks]] entries elsewhere in the file untouched — mirrors the marker
// approach stripStaleGsdHookBlocks uses for Codex's config.toml, simplified
// to plain string slicing since this block is a flat, self-contained span
// (no nested per-key structural TOML parsing is needed).
// ---------------------------------------------------------------------------

const KIMI_HOOKS_TOML_MARKER_BEGIN = '# GSD Hooks BEGIN — managed by GSD, do not edit between these markers';
const KIMI_HOOKS_TOML_MARKER_END = '# GSD Hooks END';

interface KimiHookEntrySpec {
  event: string;
  command: string | null;
  matcher?: string;
  timeout?: number;
}

function buildKimiHookEntryToml(spec: KimiHookEntrySpec): string | null {
  if (!spec.command) return null;
  const lines = ['[[hooks]]', `event = "${spec.event}"`];
  if (spec.matcher) {
    lines.push(`matcher = "${escapeTomlDoubleQuotedString(spec.matcher)}"`);
  }
  lines.push(`command = "${escapeTomlDoubleQuotedString(spec.command)}"`);
  if (typeof spec.timeout === 'number') {
    lines.push(`timeout = ${spec.timeout}`);
  }
  return lines.join('\n');
}

/**
 * Build the full marker-delimited GSD [[hooks]] block for kimi's config.toml,
 * or null when no GSD hook resolved to a usable command (hooks/ missing, or
 * the node/bash runner could not be resolved — mirrors the #1754/#3002
 * defensive guards applySettingsJsonHooks applies per-hook above).
 *
 * Event -> hook mapping mirrors applySettingsJsonHooks' settings.json wiring
 * 1:1 by GSD hook script (update check, session-state, phase-boundary,
 * graphify, context monitor, prompt/read/workflow/worktree guards, commit
 * validation). Kimi's 13 lifecycle events include exact-name equivalents for
 * every Claude-dialect event GSD currently wires (SessionStart, PreToolUse,
 * PostToolUse, Stop, PreCompact, SubagentStart, SubagentStop) — see
 * moonshotai.github.io/kimi-cli/en/customization/hooks.html.
 *
 * Matcher translation (best-effort — Kimi's tool-name vocabulary is
 * confirmed distinct from Claude's by the upstream hooks doc's own examples):
 *   Bash -> Shell, Write -> WriteFile, Edit/MultiEdit -> StrReplaceFile.
 * Read -> ReadFile follows the same WriteFile/StrReplaceFile naming
 * convention but is not independently doc-confirmed. Claude's Agent|Task
 * (subagent-dispatch) matcher segment has no confirmed Kimi tool name and is
 * dropped rather than guessed — gsd-context-monitor's PostToolUse entry runs
 * unmatched (all tools) instead, which only widens when it fires, it never
 * narrows incorrectly.
 */
function buildKimiHooksTomlBlock(targetDir: string, opts: { hookOpts: BuildHookCommandOpts }): string | null {
  const { hookOpts } = opts;
  const cmd = (hookName: string): string | null => {
    if (!fs.existsSync(path.join(targetDir, 'hooks', hookName))) return null;
    return buildHookCommand(targetDir, hookName, hookOpts);
  };

  const specs: KimiHookEntrySpec[] = [
    // SessionStart — unmatched (session-level; no tool_name to filter on).
    { event: 'SessionStart', command: cmd('gsd-check-update.js') },
    { event: 'SessionStart', command: cmd('gsd-session-state.sh') },

    // PreToolUse
    { event: 'PreToolUse', command: cmd('gsd-prompt-guard.js'), matcher: 'WriteFile|StrReplaceFile', timeout: kimiBlockingGuardTimeout('gsd-prompt-guard.js') },
    { event: 'PreToolUse', command: cmd('gsd-read-guard.js'), matcher: 'WriteFile|StrReplaceFile', timeout: 5 },
    { event: 'PreToolUse', command: cmd('gsd-worktree-path-guard.js'), matcher: 'WriteFile|StrReplaceFile', timeout: kimiBlockingGuardTimeout('gsd-worktree-path-guard.js') },
    { event: 'PreToolUse', command: cmd('gsd-write-guard.js'), matcher: 'WriteFile', timeout: kimiBlockingGuardTimeout('gsd-write-guard.js') },
    { event: 'PreToolUse', command: cmd('gsd-secret-read-guard.js'), matcher: 'ReadFile|Grep|Shell', timeout: kimiBlockingGuardTimeout('gsd-secret-read-guard.js') },
    { event: 'PreToolUse', command: cmd('gsd-workflow-guard.js'), matcher: 'Shell|WriteFile|StrReplaceFile', timeout: kimiBlockingGuardTimeout('gsd-workflow-guard.js') },
    { event: 'PreToolUse', command: cmd('gsd-validate-commit.sh'), matcher: 'Shell', timeout: kimiBlockingGuardTimeout('gsd-validate-commit.sh') },

    // PostToolUse
    { event: 'PostToolUse', command: cmd('gsd-context-monitor.js'), timeout: 10 },
    { event: 'PostToolUse', command: cmd('gsd-phase-boundary.sh'), matcher: 'WriteFile|StrReplaceFile', timeout: 5 },
    { event: 'PostToolUse', command: cmd('gsd-read-injection-scanner.js'), matcher: 'ReadFile', timeout: 5 },
    { event: 'PostToolUse', command: cmd('gsd-graphify-update.sh'), matcher: 'Shell', timeout: 5 },

    // Extended lifecycle events — context-headroom tracking (unmatched).
    { event: 'Stop', command: cmd('gsd-context-monitor.js'), timeout: 10 },
    { event: 'PreCompact', command: cmd('gsd-context-monitor.js'), timeout: 10 },
    { event: 'SubagentStart', command: cmd('gsd-context-monitor.js'), timeout: 10 },
    { event: 'SubagentStop', command: cmd('gsd-context-monitor.js'), timeout: 10 },
  ];

  const entries = specs
    .map(buildKimiHookEntryToml)
    .filter((entry): entry is string => entry !== null);
  if (entries.length === 0) return null;
  return [KIMI_HOOKS_TOML_MARKER_BEGIN, '', entries.join('\n\n'), '', KIMI_HOOKS_TOML_MARKER_END].join('\n');
}

/**
 * Strip a previously-written GSD [[hooks]] block from kimi's config.toml
 * content. Pure string function (no fs access) so install, uninstall, and
 * tests share one strip implementation. Returns null when stripping leaves
 * nothing but whitespace (the file was GSD-only), so the caller can unlink
 * it instead of writing an empty file.
 */
function stripKimiHooksTomlBlock(content: string): string | null {
  const beginIdx = content.indexOf(KIMI_HOOKS_TOML_MARKER_BEGIN);
  if (beginIdx === -1) {
    return content.trim() === '' ? null : content;
  }
  const endMarkerIdx = content.indexOf(KIMI_HOOKS_TOML_MARKER_END, beginIdx);
  if (endMarkerIdx === -1) {
    // Malformed marker pair — BEGIN present but no END after it (missing END,
    // or an END that only appears earlier in the file, before BEGIN). Never
    // fall back to content.length here: that would slice to EOF and destroy
    // every user section that follows. Leave the content untouched instead;
    // a subsequent writeKimiHooksToml call will append a fresh, well-formed
    // block rather than silently deleting user data.
    return content;
  }
  const endIdx = endMarkerIdx + KIMI_HOOKS_TOML_MARKER_END.length;

  // Swallow blank lines immediately surrounding the block so repeated
  // strip+rewrite cycles never accumulate blank lines.
  let sliceStart = beginIdx;
  while (sliceStart > 0 && (content[sliceStart - 1] === '\n' || content[sliceStart - 1] === '\r')) sliceStart -= 1;
  let sliceEnd = endIdx;
  while (sliceEnd < content.length && (content[sliceEnd] === '\n' || content[sliceEnd] === '\r')) sliceEnd += 1;

  const before = content.slice(0, sliceStart);
  const after = content.slice(sliceEnd);
  // Blank-line swallowing above consumes every newline flanking the block,
  // including the one required to keep the surrounding user sections on
  // separate lines. If the block sat BETWEEN two user sections (content
  // survives on both sides), concatenating `before` + `after` directly would
  // glue the last line of the earlier section onto the first line of the
  // later one. Reinsert a blank-line separator in that case; when only one
  // side has content (block at file start or EOF), no separator is needed —
  // that matches the pre-existing idempotent behavior for those shapes.
  const result = before.trim() !== '' && after.trim() !== ''
    ? `${before}\n\n${after}`
    : before + after;
  return result.trim() === '' ? null : result;
}

/**
 * Idempotently (re)write kimi's GSD-owned [[hooks]] block into its native
 * config.toml at `configPath` (resolved by the caller via
 * resolveKimiHooksTomlDir). No-ops (`{changed:false}`) when the computed
 * block is byte-identical to what's already on disk, so reinstalls don't
 * touch the file's mtime for no reason.
 */
function writeKimiHooksToml(
  configPath: string,
  targetDir: string,
  opts: { hookOpts: BuildHookCommandOpts },
): { changed: boolean; path: string; entryCount: number; configuredEntrypoints: ConfiguredEntrypoint[] } {
  const configuredEntrypoints: ConfiguredEntrypoint[] = [];
  const trackedOpts = {
    hookOpts: {
      ...opts.hookOpts,
      configPath,
      configuredEntrypoints,
    },
  };
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const stripped = stripKimiHooksTomlBlock(existing) ?? '';
  const block = buildKimiHooksTomlBlock(targetDir, trackedOpts);
  const entryCount = block ? (block.match(/\[\[hooks\]\]/g) || []).length : 0;

  if (!block) {
    if (stripped === existing) return { changed: false, path: configPath, entryCount: 0, configuredEntrypoints };
    if (stripped.trim() === '') {
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    } else {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      atomicWriteFileSync(configPath, stripped, 'utf8');
    }
    return { changed: true, path: configPath, entryCount: 0, configuredEntrypoints };
  }

  const separator = stripped.trim() === '' ? '' : (stripped.endsWith('\n') ? '\n' : '\n\n');
  const next = stripped.trim() === '' ? `${block}\n` : `${stripped}${separator}${block}\n`;
  if (next === existing) return { changed: false, path: configPath, entryCount, configuredEntrypoints };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  atomicWriteFileSync(configPath, next, 'utf8');
  return { changed: true, path: configPath, entryCount, configuredEntrypoints };
}

/**
 * Uninstall-time counterpart to writeKimiHooksToml: strips the GSD block and
 * deletes the file if nothing but GSD's own block was ever in it.
 */
function removeKimiHooksToml(configPath: string): { changed: boolean } {
  if (!fs.existsSync(configPath)) return { changed: false };
  const existing = fs.readFileSync(configPath, 'utf8');
  const stripped = stripKimiHooksTomlBlock(existing);
  if (stripped === existing) return { changed: false };
  if (stripped === null || stripped.trim() === '') {
    fs.unlinkSync(configPath);
  } else {
    atomicWriteFileSync(configPath, stripped, 'utf8');
  }
  return { changed: true };
}

// ---------------------------------------------------------------------------
// Blocking-guard host budget (#3981, #5180)
//
// Claude Code treats a timed-out hook as NON-blocking — the tool call
// continues through the normal permission flow. The blocking PreToolUse
// guards therefore need a budget a host stall cannot exceed, not one sized to
// the hook's own ~0.1 s runtime. Observed stalls reached 84.3 s; 120 s is the
// top of the issue's prescribed 60–120 range and returns every observed
// verdict. ONE constant and ONE name list, shared by every registration
// surface that carries a host timeout (settings.json install + migration,
// Kimi config.toml) so a future change cannot diverge between them.
// ---------------------------------------------------------------------------

const BLOCKING_GUARD_TIMEOUT_S = 120;

const BLOCKING_GUARD_NAMES: readonly string[] = [
  'gsd-prompt-guard',
  'gsd-workflow-guard',
  'gsd-worktree-path-guard',
  'gsd-agent-isolation-guard',
  'gsd-write-guard',
  'gsd-secret-read-guard',
  'gsd-validate-commit',
];

// Kimi registers every blocking guard EXCEPT the ones named here: Claude's
// Agent|Task (subagent-dispatch) matcher segment has no confirmed Kimi tool
// name, so gsd-agent-isolation-guard has nothing to attach to there (see the
// buildKimiHooksTomlBlock doc). The divergence from the installer's set is
// intentional and explicit, not an accident of two hand-kept lists.
const KIMI_UNREGISTERED_BLOCKING_GUARDS: readonly string[] = ['gsd-agent-isolation-guard'];

const KIMI_BLOCKING_GUARD_NAMES: readonly string[] = BLOCKING_GUARD_NAMES.filter(
  (name) => !KIMI_UNREGISTERED_BLOCKING_GUARDS.includes(name),
);

// Host budget for a Kimi blocking-guard entry, by script file name. Throws for
// a script outside KIMI_BLOCKING_GUARD_NAMES so a spec cannot claim the
// blocking budget for a hook the shared list does not name.
function kimiBlockingGuardTimeout(scriptFile: string): number {
  const name = scriptFile.replace(/\.(?:js|sh)$/, '');
  if (!KIMI_BLOCKING_GUARD_NAMES.includes(name)) {
    throw new Error(`runtime-hooks-surface: ${scriptFile} is not a Kimi blocking guard (KIMI_BLOCKING_GUARD_NAMES)`);
  }
  return BLOCKING_GUARD_TIMEOUT_S;
}

// ---------------------------------------------------------------------------
// referencesHook
//
// Pure predicate — checks whether a hook entry object references a managed
// hook by name.  Covers all three registration shapes used by GSD:
//   • plain command string (standard form)
//   • args array (command+args / wrapped-launcher form used by windowless
//     launchers on Windows and some custom PATH-less environments) (#976)
//   • url field (type:"http" local-server routing form) (#1004)
// Without covering all three, an http-form or args-form entry is invisible
// and a stock string-command entry is appended on every install/update,
// running the hook twice.
//
// Originally declared inside install()/finishInstall() as a local function;
// promoted here so applySettingsJsonHooks() and finishInstall() share one
// copy (ADR-857 phase 5f-1b).
// ---------------------------------------------------------------------------

function referencesHook(h: Record<string, unknown>, hookName: string): boolean {
  const cmd = h['command'];
  const args = h['args'];
  const url = h['url'];
  return (typeof cmd === 'string' && cmd.includes(hookName)) ||
    (Array.isArray(args) && args.some(a => typeof a === 'string' && a.includes(hookName))) ||
    (typeof url === 'string' && url.includes(hookName));
}

type ConfiguredEntrypointFailureReason = 'missing' | 'unreadable' | 'wrong-file-type' | 'unresolved-interpreter' | 'not-executable';

interface ConfiguredEntrypoint {
  runtime: string;
  configPath: string;
  scriptPath: string;
  interpreterCandidates?: string[];
  // #4249 (CodeRabbit): true when the OS execs scriptPath directly (via a
  // shebang, or Windows' own .cmd extension dispatch) — orthogonal to
  // interpreterCandidates, which every producer that needs both sets
  // alongside this rather than relying on their absence. Most self-executable
  // entries have no candidates (a Windows-Claude .sh hook, Codex's .cmd shim);
  // Cline's `#!/usr/bin/env node` is a hybrid needing both: the execute bit
  // AND `node` resolving on PATH.
  selfExecutable?: boolean;
  platform?: string;
  command?: string;
}

interface ConfiguredEntrypointInvalid {
  runtime: string;
  configPath: string;
  role: 'script' | 'interpreter';
  path: string;
  reason: ConfiguredEntrypointFailureReason;
}

type ConfiguredEntrypointValidationResult =
  | { ok: true }
  | { ok: false; invalid: ConfiguredEntrypointInvalid[] };

// #5100: the writer emits the bare `bash` token when the Git Bash policy
// finds nothing, and the gate resolves that token through the same policy —
// never a PATH scan. One shared definition so the two sides cannot drift.
const UNRESOLVED_BASH_SENTINEL = 'bash';
const WIN32_BARE_BASH_TOKENS = [UNRESOLVED_BASH_SENTINEL, 'bash.exe'];

function isWin32BareBashToken(candidate: string, platform?: string): boolean {
  if ((platform || process.platform) !== 'win32') return false;
  // Equality already rejects any path: a string holding a separator can never
  // equal a bare token, so no explicit separator guard is needed here.
  return WIN32_BARE_BASH_TOKENS.includes(candidate.trim().toLowerCase());
}

// #5100: the literal `bash` sentinel means "Git Bash policy found nothing"
// (#4249). Resolve that token through resolveBashExecutable, never a PATH
// scan — WSL's System32\bash.exe is on PATH and cannot see Windows paths.
function win32BareBashResolves(
  candidate: string,
  platform: string | undefined,
  deps: { env?: NodeJS.ProcessEnv; existsSync?: (p: string) => boolean },
): boolean | null {
  if (!isWin32BareBashToken(candidate, platform)) return null;
  return resolveBashExecutable({
    platform: 'win32',
    env: deps.env,
    existsSync: deps.existsSync,
  }) !== null;
}

function validateConfiguredEntrypoints(
  entries: ConfiguredEntrypoint[],
  deps: {
    statSync?: typeof fs.statSync;
    accessSync?: typeof fs.accessSync;
    resolveExecutableBinary?: typeof resolveExecutableBinary;
    env?: NodeJS.ProcessEnv;
    existsSync?: (p: string) => boolean;
  } = {},
): ConfiguredEntrypointValidationResult {
  const statSync = deps.statSync ?? fs.statSync;
  const accessSync = deps.accessSync ?? fs.accessSync;
  const resolve = deps.resolveExecutableBinary ?? resolveExecutableBinary;
  const invalid: ConfiguredEntrypointInvalid[] = [];
  for (const entry of entries) {
    let scriptOk = false;
    try {
      scriptOk = statSync(entry.scriptPath).isFile();
      if (!scriptOk) {
        invalid.push({ runtime: entry.runtime, configPath: entry.configPath, role: 'script', path: entry.scriptPath, reason: 'wrong-file-type' });
      } else {
        // #4249: statSync only needs search permission on the parent dirs, so
        // it succeeds even for a chmod-000 file — the EACCES catch below
        // never fires for that case. Read permission on the file itself must
        // be checked explicitly: an interpreter opens the script directly,
        // and even a self-executable shebang script is opened and read by
        // its kernel-invoked interpreter, not just exec'd — X_OK alone does
        // not prove it's readable.
        try {
          accessSync(entry.scriptPath, fs.constants.R_OK);
        } catch {
          scriptOk = false;
          invalid.push({ runtime: entry.runtime, configPath: entry.configPath, role: 'script', path: entry.scriptPath, reason: 'unreadable' });
        }
      }
    } catch (statErr) {
      // #4249 Nit: EACCES means a parent directory couldn't be searched —
      // a real (if rare) permission problem, distinct from ENOENT's "missing".
      // EPERM: Windows' equivalent permission-denied code for a directory a
      // parent path couldn't be traversed into.
      const code = (statErr as NodeJS.ErrnoException)?.code;
      const reason = code === 'EACCES' || code === 'EPERM' ? 'unreadable' : 'missing';
      invalid.push({ runtime: entry.runtime, configPath: entry.configPath, role: 'script', path: entry.scriptPath, reason });
    }
    // #4249: selfExecutable is the sole source of truth for whether the OS
    // execs scriptPath directly via its own shebang (set explicitly by every
    // producer that needs it — a Windows-Claude .sh hook, Codex's Windows
    // .cmd shim, Cline's hybrid `env node` hook — rather than inferred from
    // the absence of interpreterCandidates, which Cline's hybrid case also
    // carries). Skip on win32 like resolveExecutableBinary's own X_OK
    // carve-out does: POSIX mode bits don't mean executable on Windows, and a
    // real accessSync(X_OK) there would fail a .cmd shim under a test that
    // simulates win32 on a POSIX runner (Node's own no-op only protects an
    // actual Windows machine). Cline is the only producer where this runs.
    if (scriptOk && entry.selfExecutable && (entry.platform ?? process.platform) !== 'win32') {
      try {
        accessSync(entry.scriptPath, fs.constants.X_OK);
      } catch {
        invalid.push({ runtime: entry.runtime, configPath: entry.configPath, role: 'script', path: entry.scriptPath, reason: 'not-executable' });
      }
    }
    if (entry.interpreterCandidates && !entry.interpreterCandidates.some(candidate => {
      const bareBash = win32BareBashResolves(candidate, entry.platform, deps);
      if (bareBash !== null) return bareBash;
      return resolve(candidate, { platform: entry.platform, requireExecutable: true }) !== null;
    })) {
      invalid.push({ runtime: entry.runtime, configPath: entry.configPath, role: 'interpreter', path: entry.interpreterCandidates.join(' | '), reason: 'unresolved-interpreter' });
    }
  }
  return invalid.length === 0 ? { ok: true } : { ok: false, invalid };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export = {
  // Cline
  buildClineRulesBody,
  buildClineAgentsMdBody,
  buildClinePreToolUseHook,
  mergeGsdAgentsMd,
  writeClineArtifacts,
  GSD_AGENTS_MD_MARKER,
  GSD_AGENTS_MD_CLOSE_MARKER,

  // Cursor
  buildCursorHookEntry,
  isManagedCursorHookEntry,
  reconcileCursorHooksJson,
  writeCursorHooksJson,
  removeCursorHooksJson,
  GSD_CURSOR_SESSION_HOOK_SCRIPT,
  GSD_CURSOR_POST_TOOL_HOOK_SCRIPT,
  GSD_CURSOR_PRE_TOOL_HOOK_SCRIPT,
  GSD_CURSOR_STOP_HOOK_SCRIPT,
  GSD_CURSOR_SUBAGENT_START_HOOK_SCRIPT,
  GSD_CURSOR_SUBAGENT_STOP_HOOK_SCRIPT,
  GSD_CURSOR_HOOK_MARKER,

  // Windsurf/Cascade
  buildWindsurfHookEntry,
  isManagedWindsurfHookEntry,
  reconcileWindsurfHooksJson,
  writeWindsurfHooksJson,
  removeWindsurfHooksJson,
  WINDSURF_HOOK_EVENTS,
  WINDSURF_EVENT_SCRIPT_MAP,
  GSD_WINDSURF_PRE_WRITE_HOOK_SCRIPT,
  GSD_WINDSURF_PRE_COMMAND_HOOK_SCRIPT,
  GSD_WINDSURF_HOOK_SCRIPTS,
  ensureCommonJsMarker,
  removeCommonJsMarkerIfGsdOwned,
  GSD_WINDSURF_HOOK_MARKER,

  // Copilot
  buildCopilotHookConfig,
  writeCopilotHookConfig,
  GSD_COPILOT_HOOK_FILE,

  // Codex hooks.json
  reconcileCodexHooksJsonEvent,
  reconcileCodexHooksJsonSessionStart,
  ensureCodexHooksJsonSessionStart,
  ensureCodexHooksJsonEvent,
  removeCodexHooksJsonEvent,
  removeCodexHooksJsonSessionStart,
  buildCodexHookWindowsShimIR,
  cleanupOrphanedCodexContextMonitorScript,
  isGsdOwnedCodexContextMonitorScript,
  hooksJsonReferencesCodexContextMonitor,

  // Codex TOML
  buildCodexHookBlock,
  rewriteLegacyCodexHookBlock,

  // Kimi hooks.toml
  buildKimiHooksTomlBlock,
  stripKimiHooksTomlBlock,
  writeKimiHooksToml,
  removeKimiHooksToml,
  KIMI_HOOKS_TOML_MARKER_BEGIN,
  KIMI_HOOKS_TOML_MARKER_END,

  // Blocking-guard host budget (#3981, #5180)
  BLOCKING_GUARD_TIMEOUT_S,
  BLOCKING_GUARD_NAMES,
  KIMI_UNREGISTERED_BLOCKING_GUARDS,
  KIMI_BLOCKING_GUARD_NAMES,

  // Shared
  stageTransitiveHookLibs,
  buildHookCommand,
  recordConfiguredHookCommand,
  applySettingsJsonHooks,
  applySettingsJsonHookTables,
  SETTINGS_JSON_HOOK_ROWS,
  SETTINGS_JSON_EXTENDED_ROWS,
  validateConfiguredEntrypoints,
  referencesHook,
  rewriteLegacyManagedNodeHookCommands,
  reconcileManagedShellHookCommands,
  normalizeNodePath,
  resolveNodeRunner,
  buildNodeRunnerChainToken,
  resolveBashExecutable,
  resolveBashRunner,
  NODE_RUNNER_RESOLVER_HOOK,
  // #5100: the installer reads the sentinel off the tracked entry it wrote,
  // so the literal it matches on comes from here rather than being spelled a
  // second time in bin/install.js.
  UNRESOLVED_BASH_SENTINEL,

  // Atomic write seam (shared with bin/install.js so all writes participate
  // in install.js's _cleanTmpFiles() scoped temp-cleanup).
  atomicWriteFileSync,
  __atomicWrittenTmps,
};
