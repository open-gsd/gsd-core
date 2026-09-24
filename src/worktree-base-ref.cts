/**
 * Worktree base-ref detection and degradation logic (issue #683).
 *
 * Determines whether a worktree's HEAD has drifted from the fork base that the
 * Claude Code harness would use to create a 'fresh' parallel worktree. When
 * drift is detected the caller should fall back to sequential execution on the
 * main working tree to avoid a base mismatch.
 *
 * Pure/testable module: all I/O is injectable via the `deps` argument so unit
 * tests can run without touching the real filesystem or spawning real git.
 */

import fs from 'node:fs';
import path from 'node:path';

import { execGit as execGitSeam, isSpawnTimeout } from './shell-command-projection.cjs';
import { getGlobalConfigDir } from './runtime-homes.cjs';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Strip JSONC comments (line and block forms) from a string to produce valid JSON.
 * Handles comments inside strings correctly (does not strip them).
 * Mirrors the same logic in bin/install.js:stripJsonComments.
 */
function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  while (i < text.length) {
    // Handle string literals — don't strip comments inside strings
    if (inString) {
      if (text[i] === '\\') {
        result += text[i] + (text[i + 1] || '');
        i += 2;
        continue;
      }
      if (text[i] === stringChar) {
        inString = false;
      }
      result += text[i];
      i++;
      continue;
    }
    // Start of string
    if (text[i] === '"' || text[i] === "'") {
      inString = true;
      stringChar = text[i];
      result += text[i];
      i++;
      continue;
    }
    // Line comment
    if (text[i] === '/' && text[i + 1] === '/') {
      // Skip to end of line
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2; // skip closing */
      continue;
    }
    result += text[i];
    i++;
  }
  // Remove trailing commas before } or ] (common in JSONC)
  return result.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Parse a string as JSONC (JSON with comments). Returns the parsed value or
 * throws a SyntaxError if the content is genuinely malformed.
 */
function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripJsonComments(text));
  }
}

// ─── Internal types ───────────────────────────────────────────────────────────

type ExecGitFn = typeof execGitSeam;

// Who creates the isolated worktree — the two worktree-creating members of
// host-integration.cts's DispatchIsolation vocabulary ('none' creates none and
// never reaches this check).
type BaseCheckIsolationMode = 'harness-worktree' | 'orchestrator-worktree';

/**
 * A settings layer that defeats the `worktree.baseRef:"head"` trust (#4588): either it
 * declares a Claude Code `WorktreeCreate` hook (`kind: 'hook'`), or it exists but does not
 * parse, so a hook in it cannot be ruled out (`kind: 'unparseable'`). `file` is the path.
 */
export type WorktreeCreateHookFinding = { file: string; kind: 'hook' | 'unparseable' };

// ─── Message constants (verbatim — downstream docs/tests depend on these) ─────

// The fork side of the comparison is either an inferred ref (`origin/HEAD`,
// `origin/next`, …) or — when the caller supplies `observedForkBase` — the
// literal label below, meaning "the base a worktree this host created was
// measured to have" (#4588). Messages read the label to phrase the remedy.
const FORK_REF_OBSERVED = 'observed';

function describeForkRef(forkRef: string | null): string {
  return forkRef === FORK_REF_OBSERVED ? 'the observed fork base' : String(forkRef);
}

// An observation is a fixed measurement of one past dispatch: pushing cannot change it,
// so the remedy for an observed mismatch is a fresh dispatch (a new observation), never
// "push until the observation matches". The inferred fork base (origin/HEAD) does move
// with a push, so that remedy stays for the inferred case.
function buildMsgDiverged(headSha: string | null, forkRef: string | null, forkSha: string | null): string {
  const fork = describeForkRef(forkRef);
  const remedy = forkRef === FORK_REF_OBSERVED
    ? 'Parallel worktrees return once a fresh dispatch is observed to fork from HEAD, or once HEAD is merged/pushed so the default fork base matches it'
    : `Parallel worktrees return once HEAD is merged/pushed so ${fork} matches it`;
  return `⚠ Worktree base mismatch: HEAD (${shortSha(headSha)}) differs from ${fork} (${shortSha(forkSha)}). Running this phase sequentially on the main working tree. ${remedy}, or set worktree.baseRef:"head" to fork worktrees from HEAD instead (honored by GSD-created worktrees and by the Claude Code harness; #683, #4588).`;
}

const MSG_UNKNOWN = `⚠ Cannot determine the worktree fork base (origin/HEAD unresolved). Running this phase sequentially on the main working tree to avoid a base mismatch. Parallel worktrees return once origin/HEAD resolves and matches HEAD. See #683, #3659.`;

// Mode-neutral on purpose: the observation can come from a harness-created OR a
// GSD-created worktree, and the message must not attribute the miss to "the harness"
// when GSD's own `git worktree add` was the creator (P4.6 review, 2026-09-14).
function buildMsgBaserefHeadIgnored(headSha: string | null, forkSha: string | null): string {
  return `⚠ Worktree base mismatch: worktree.baseRef:"head" is set, but a worktree created for this dispatch was observed to fork from ${shortSha(forkSha)} while HEAD is ${shortSha(headSha)} — the worktree was not forked from HEAD despite the setting. Running this phase sequentially on the main working tree. Parallel worktrees return once a fresh dispatch is observed to fork from HEAD, or once HEAD is merged/pushed so the default fork base matches it. See #3659, #4588.`;
}

// Names the hook and its file, never "the harness": the user configured the hook, so the
// actionable remedy is theirs. An unparseable layer is phrased as "cannot be ruled out",
// because the check does not know a hook is there — it only cannot prove one is not.
// It deliberately promises nothing about pushing: neither HEAD nor the inferred fork base
// says where a hook forks, so the only measured way back to a trusted verdict is an
// observation (--observed-fork-base) or removing the cause (#4588 round review).
function buildMsgBaserefHeadHookBypass(
  headSha: string | null,
  forkRef: string | null,
  forkSha: string | null,
  finding: WorktreeCreateHookFinding
): string {
  const fork = describeForkRef(forkRef);
  const cause = finding.kind === 'hook'
    ? `a Claude Code WorktreeCreate hook is configured in ${finding.file}`
    : `${finding.file} could not be parsed, so a Claude Code WorktreeCreate hook in it cannot be ruled out`;
  const remove = finding.kind === 'hook'
    ? 'remove the hook'
    : `fix ${finding.file} so it parses`;
  return `⚠ Worktree base mismatch: worktree.baseRef:"head" is set, but ${cause}. A WorktreeCreate hook creates Claude Code's agent worktrees itself and Claude Code does not apply worktree.baseRef to them, so the setting is not trusted. Without it the check can only compare HEAD (${shortSha(headSha)}) against ${fork} (${shortSha(forkSha)}), and they differ. Running this phase sequentially on the main working tree. Neither ref says where the hook forks: for a measured verdict, pass the commit a hook-created worktree starts at as --observed-fork-base, or ${remove}. See #4588.`;
}

// A commit sha as `git rev-parse HEAD` prints it: 40 hex (SHA-1) or 64 hex (SHA-256).
// Abbreviated shas are refused rather than prefix-matched — the comparison below is
// exact, and an abbreviation that can never equal the full HEAD would silently always
// degrade (P4.6 review, 2026-09-14). Case is folded because the comparison is exact.
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MSG_OBSERVED_FORK_BASE_INVALID = 'observedForkBase must be a full 40- or 64-hex commit sha (git rev-parse HEAD inside the worktree, before any commit)';

const MSG_HEAD_UNRESOLVABLE = `⚠ Cannot determine the worktree base (git rev-parse HEAD did not return a definitive answer). Running this phase sequentially on the main working tree to avoid an unverified base mismatch. Retry; if it persists, check for a stalled filesystem mount or a stale git index lock (.git/index.lock). See #683, #3050.`;

const MSG_NO_GIT_REPOSITORY = `⚠ No worktree base exists here (git resolved no HEAD — the root is not a git repository, or the repository has no commits), so a harness worktree cannot be created. Running this dispatch sequentially on the main working tree instead — no isolation flag is required. See #4734.`;

/**
 * Returns true when an execGit result indicates the subprocess was killed by
 * a timeout. A timeout means the command genuinely could not complete — it
 * must never be treated the same as a clean non-zero exit (e.g. "not a git
 * repository"), which DID complete and reported a real answer.
 *
 * Delegates to the single shared predicate in shell-command-projection.cts
 * (#3050 — "Generative Fix Divergence"); do not reimplement this locally.
 */
function isExecGitTimeout(result: { signal: string | null; error: unknown }): boolean {
  return isSpawnTimeout(result);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Returns the first 8 characters of a SHA, or '' if null/empty.
 */
export function shortSha(sha: string | null): string {
  if (!sha) return '';
  return sha.slice(0, 8);
}

/**
 * Extracts settings.worktree.baseRef if it is a string; otherwise null.
 * Defensive: settings may be null/undefined, worktree may be missing or
 * not an object.
 */
export function readBaseRefFromSettings(settings: unknown): string | null {
  if (settings == null || typeof settings !== 'object') return null;
  const s = settings as Record<string, unknown>;
  if (s.worktree == null || typeof s.worktree !== 'object' || Array.isArray(s.worktree)) return null;
  const worktree = s.worktree as Record<string, unknown>;
  if (typeof worktree.baseRef !== 'string') return null;
  return worktree.baseRef;
}

/**
 * No-clobber application of worktree.baseRef = 'head'.
 *
 * - If baseRef is absent/null/undefined → set to 'head', return changed:true.
 * - If already 'head' → skip, return skipped:'already-head'.
 * - If any other string → skip without overwriting, return skipped:'explicit-other'.
 *
 * Mutates `settings` in place and also returns it.
 */
export function applyWorktreeBaseRef(settings: Record<string, unknown>): {
  changed: boolean;
  settings: object;
  skipped: null | 'already-head' | 'explicit-other';
  previous: string | null;
} {
  // Defensive: caller must pass a plain object — reject null, arrays, and primitives.
  if (settings === null || Array.isArray(settings) || typeof settings !== 'object') {
    throw new TypeError(`applyWorktreeBaseRef: expected a plain object, got ${settings === null ? 'null' : Array.isArray(settings) ? 'array' : typeof settings}`);
  }
  // Ensure worktree object exists, preserving any existing keys
  if (settings.worktree == null || typeof settings.worktree !== 'object' || Array.isArray(settings.worktree)) {
    settings.worktree = {};
  }
  const worktree = settings.worktree as Record<string, unknown>;
  const current = typeof worktree.baseRef === 'string' ? worktree.baseRef : null;

  if (current === 'head') {
    return { changed: false, settings, skipped: 'already-head', previous: 'head' };
  }
  if (current !== null) {
    // Some other explicit string value — don't overwrite
    return { changed: false, settings, skipped: 'explicit-other', previous: current };
  }
  // Absent/null/undefined → set to 'head'
  worktree.baseRef = 'head';
  return { changed: true, settings, skipped: null, previous: null };
}

/**
 * Reads settings files in a 3-layer cascade and extracts worktree.baseRef from
 * the first layer that provides a non-null string value. Layers (highest to lowest
 * precedence):
 *   1. project local  — <claudeDir>/settings.local.json
 *   2. project shared — <claudeDir>/settings.json
 *   3. user/global    — <userClaudeDir>/settings.json  (only when userClaudeDir is
 *                       provided AND resolves to a different path than claudeDir)
 *
 * deps.readFile(path) must return the file contents or null on any error.
 * userClaudeDir is optional; when absent/null the user/global layer is skipped.
 */
export function resolveEffectiveBaseRef(
  claudeDir: string,
  deps?: { readFile?: (p: string) => string | null },
  userClaudeDir?: string | null
): string | null {
  const readFile: (p: string) => string | null = deps?.readFile ?? ((p: string) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  });

  const localPath = path.join(claudeDir, 'settings.local.json');
  const sharedPath = path.join(claudeDir, 'settings.json');

  function parseBaseRef(filePath: string): string | null {
    const contents = readFile(filePath);
    if (contents == null) return null;
    try {
      const parsed: unknown = parseJsonc(contents);
      return readBaseRefFromSettings(parsed);
    } catch {
      return null;
    }
  }

  // Layer 1: project local
  const localRef = parseBaseRef(localPath);
  if (localRef !== null) return localRef;

  // Layer 2: project shared
  const sharedRef = parseBaseRef(sharedPath);
  if (sharedRef !== null) return sharedRef;

  // Layer 3: user/global (only when provided and not the same directory as claudeDir)
  if (userClaudeDir && path.resolve(userClaudeDir) !== path.resolve(claudeDir)) {
    const userSharedPath = path.join(userClaudeDir, 'settings.json');
    const userRef = parseBaseRef(userSharedPath);
    if (userRef !== null) return userRef;
  }

  return null;
}

/**
 * Looks for a Claude Code `WorktreeCreate` hook in the settings layers that
 * resolveEffectiveBaseRef reads (#4588). Such a hook replaces the harness's own worktree
 * creation: the agent worktree is whatever directory the hook emits, and Claude Code does
 * not consult `worktree.baseRef` on that path. So on a host that configures one, `"head"`
 * says nothing about where a harness-created worktree forks from.
 *
 * Claude Code merges hooks across layers, so every layer is checked — not only the one
 * that supplied `baseRef`. Layers, in the same order and with the same user/global
 * de-duplication as resolveEffectiveBaseRef:
 *   1. <claudeDir>/settings.local.json
 *   2. <claudeDir>/settings.json
 *   3. <userClaudeDir>/settings.json (only when provided and a different directory)
 *
 * Returns the first finding in that order, or null:
 *   - kind 'hook'        — `hooks.WorktreeCreate` is present and not an empty list.
 *   - kind 'unparseable' — the file exists but is not valid JSON/JSONC. Fails closed: a hook
 *                          in it cannot be ruled out, and a false degrade costs a sequential
 *                          wave where false trust costs every executor halting at exit 42.
 * A layer deps.readFile reports as null (absent or unreadable) is skipped, exactly as in
 * resolveEffectiveBaseRef, and so is a whitespace-only file, which cannot declare a hook.
 *
 * Settings files are the only hook sources readable from here. Claude Code also takes
 * hooks from managed policy settings, a --settings file, plugins, agent frontmatter and
 * SDK registrations; those stay invisible to this check, and the spawn-time exit-42 guard
 * remains the backstop for them.
 */
export function findWorktreeCreateHook(
  claudeDir: string,
  deps?: { readFile?: (p: string) => string | null },
  userClaudeDir?: string | null
): WorktreeCreateHookFinding | null {
  const readFile: (p: string) => string | null = deps?.readFile ?? ((p: string) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  });

  const layers = [path.join(claudeDir, 'settings.local.json'), path.join(claudeDir, 'settings.json')];
  if (userClaudeDir && path.resolve(userClaudeDir) !== path.resolve(claudeDir)) {
    layers.push(path.join(userClaudeDir, 'settings.json'));
  }

  for (const file of layers) {
    const contents = readFile(file);
    if (contents == null || contents.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = parseJsonc(contents);
    } catch {
      return { file, kind: 'unparseable' };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const hooks = (parsed as Record<string, unknown>).hooks;
    if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) continue;
    const entry = (hooks as Record<string, unknown>).WorktreeCreate;
    if (entry == null || (Array.isArray(entry) && entry.length === 0)) continue;
    return { file, kind: 'hook' };
  }
  return null;
}

/**
 * CLI command: check current worktree base-ref degradation status.
 *
 * Reads effective baseRef from <cwd>/.claude settings (3-layer cascade:
 * project local → project shared → user/global), runs degradation evaluation,
 * writes JSON result to stdout (or injected write), and returns the result object.
 *
 * deps.userClaudeDir overrides the user/global config directory resolution
 * (default: getGlobalConfigDir('claude'), which honours CLAUDE_CONFIG_DIR).
 */
export function cmdWorktreeBaseCheck(
  cwd: string,
  args: string[],
  deps?: { execGit?: ExecGitFn; readFile?: (p: string) => string | null; write?: (s: string) => void; userClaudeDir?: string | null }
): ReturnType<typeof evaluateWorktreeBaseDegrade> {
  // --mode threads the dispatch isolation mode through to the evaluation
  // (#3659): 'harness-worktree' (default) or 'orchestrator-worktree'. Invalid
  // or missing values after --mode fail closed — a silently defaulted typo
  // would re-open the hole the flag exists to close.
  let isolationMode: BaseCheckIsolationMode = 'harness-worktree';
  const modeIdx = args.indexOf('--mode');
  if (modeIdx !== -1) {
    const value = args[modeIdx + 1];
    if (value !== 'harness-worktree' && value !== 'orchestrator-worktree') {
      throw new Error(`worktree base-check: --mode must be harness-worktree or orchestrator-worktree, got ${JSON.stringify(value ?? null)}`);
    }
    isolationMode = value;
  }
  // --observed-fork-base <sha> threads a measured fork base through to the
  // evaluation (#4588): what `git rev-parse HEAD` returned inside a worktree
  // this host created, before any commit. Same fail-closed shape as --mode —
  // a malformed or missing value throws rather than silently falling back to
  // the inference the flag exists to replace.
  let observedForkBase: string | null = null;
  const observedIdx = args.indexOf('--observed-fork-base');
  if (observedIdx !== -1) {
    const value = args[observedIdx + 1];
    if (typeof value !== 'string' || !FULL_SHA_RE.test(value.trim().toLowerCase())) {
      throw new Error(`worktree base-check: --observed-fork-base: ${MSG_OBSERVED_FORK_BASE_INVALID}, got ${JSON.stringify(value ?? null)}`);
    }
    observedForkBase = value.trim().toLowerCase();
  }
  const claudeDir = path.join(cwd, '.claude');
  const userClaudeDir = Object.prototype.hasOwnProperty.call(deps ?? {}, 'userClaudeDir')
    ? (deps as { userClaudeDir?: string | null }).userClaudeDir
    : getGlobalConfigDir('claude');
  const effectiveBaseRef = resolveEffectiveBaseRef(
    claudeDir,
    deps?.readFile ? { readFile: deps.readFile } : undefined,
    userClaudeDir
  );
  // The WorktreeCreate-hook interlock (#4588) only matters where the evaluation would
  // otherwise trust "head" without comparing: harness-created worktrees and no
  // observation. Skip the settings reads everywhere else.
  const worktreeCreateHook = effectiveBaseRef === 'head' && isolationMode === 'harness-worktree' && observedForkBase === null
    ? findWorktreeCreateHook(claudeDir, deps?.readFile ? { readFile: deps.readFile } : undefined, userClaudeDir)
    : null;
  const result = evaluateWorktreeBaseDegrade({
    cwd,
    effectiveBaseRef,
    execGit: deps?.execGit,
    isolationMode,
    observedForkBase,
    worktreeCreateHook,
  });
  // Default emit goes through fs.writeSync(1, …), NOT process.stdout.write:
  // the CLI's --pick capture intercepts writeSync, and command substitution
  // is a pipe — via process.stdout.write a `$(gsd-tools … --pick x)` capture
  // received the full JSON instead of the picked field, so the workflow
  // auto-degrade guards never matched (#3659 review). Short-count loop per
  // io.cjs writeAllSync's rationale (a non-blocking pipe can accept partial
  // writes).
  const write = deps?.write ?? ((s: string) => {
    const buf = Buffer.from(s, 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      offset += fs.writeSync(1, buf, offset, buf.length - offset);
    }
  });
  write(JSON.stringify(result, null, 2) + '\n');
  return result;
}

/**
 * CLI command: write worktree.baseRef = 'head' into <cwd>/.claude/settings.local.json.
 *
 * No-clobber: if the file already has an explicit baseRef that is not 'head',
 * the existing value is preserved and output reflects skipped:'explicit-other'.
 * If the file contains malformed JSON, throws a clear error rather than
 * silently clobbering the user's file.
 */
export function cmdWorktreeSetBaseRef(
  cwd: string,
  _args: string[],
  deps?: {
    readFile?: (p: string) => string | null;
    writeFile?: (p: string, content: string) => void;
    mkdir?: (p: string, opts: { recursive: boolean }) => void;
    existsSync?: (p: string) => boolean;
    write?: (s: string) => void;
  }
): { changed: boolean; skipped: null | 'already-head' | 'explicit-other'; previous: string | null; file: string; baseRef: string } {
  const file = path.join(cwd, '.claude', 'settings.local.json');
  const readFile: (p: string) => string | null = deps?.readFile ??
    ((p: string) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } });

  const raw = readFile(file);
  let settings: Record<string, unknown> = {};
  if (raw != null) {
    let parsed: unknown;
    try {
      parsed = parseJsonc(raw);
    } catch {
      throw new Error(`Refusing to modify ${file}: existing JSON is malformed`);
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error(`Refusing to modify ${file}: expected a JSON object at the top level`);
    }
    settings = parsed as Record<string, unknown>;
  }

  const apply = applyWorktreeBaseRef(settings);

  if (apply.changed) {
    const dir = path.dirname(file);
    const existsSync: (p: string) => boolean = deps?.existsSync ?? fs.existsSync;
    const mkdirFn: (p: string, opts: { recursive: boolean }) => void = deps?.mkdir ??
      ((p: string, opts: { recursive: boolean }) => { fs.mkdirSync(p, opts); });
    if (!existsSync(dir)) {
      mkdirFn(dir, { recursive: true });
    }
    const writeFile: (p: string, content: string) => void = deps?.writeFile ??
      ((p: string, content: string) => { fs.writeFileSync(p, content, 'utf8'); });
    writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  }

  const output = {
    changed: apply.changed,
    skipped: apply.skipped,
    previous: apply.previous,
    baseRef: 'head' as const,
    file,
  };
  // Default emit goes through fs.writeSync(1, …), NOT process.stdout.write:
  // the CLI's --pick capture intercepts writeSync, and command substitution
  // is a pipe — via process.stdout.write a `$(gsd-tools … --pick x)` capture
  // received the full JSON instead of the picked field, so the workflow
  // auto-degrade guards never matched (#3659 review). Short-count loop per
  // io.cjs writeAllSync's rationale (a non-blocking pipe can accept partial
  // writes).
  const write = deps?.write ?? ((s: string) => {
    const buf = Buffer.from(s, 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      offset += fs.writeSync(1, buf, offset, buf.length - offset);
    }
  });
  write(JSON.stringify(output, null, 2) + '\n');
  return output;
}

/**
 * One classification of `git rev-parse HEAD`, shared by every surface that
 * must tell git's definitive "no repository here" answer apart from ambiguous
 * or failed resolutions (#4734 — before this, evaluateWorktreeBaseDegrade was
 * the only owner and the isolation guard's fallback simply had no check).
 * Exit 128 covers BOTH "not a git repository" and "a repository with no
 * commits" (`ambiguous argument 'HEAD'`); stderr text is localized, so the
 * exit code is the stable contract — and in neither case can a harness
 * worktree be created, which is the only question every consumer asks.
 *
 * - `present`: exit 0 with a non-empty sha (`headSha` carries it, trimmed).
 * - `definitive-absence`: exit 128 — git completed and definitively answered.
 * - `ambiguous-absence`: exit 0 with empty stdout — git completed without a
 *   definitive answer (#3057 B8).
 * - `indeterminate`: timeout or any other non-success — never evidence of
 *   anything; consumers must fail closed (#3050).
 */
export function classifyGitHead(deps?: {
  execGit?: ExecGitFn;
  cwd?: string;
}): { status: 'definitive-absence'; headSha: null } | { status: 'ambiguous-absence'; headSha: null } | { status: 'indeterminate'; headSha: null } | { status: 'present'; headSha: string } {
  const execGit: ExecGitFn = deps?.execGit ?? execGitSeam;
  const cwdOpts = deps?.cwd ? { cwd: deps.cwd } : {};
  const headResult = execGit(['rev-parse', 'HEAD'], cwdOpts);
  if (isExecGitTimeout(headResult)) {
    return { status: 'indeterminate', headSha: null };
  }
  const headStdout = headResult.stdout ? headResult.stdout.trim() : '';
  if (headResult.exitCode === 128) {
    return { status: 'definitive-absence', headSha: null };
  }
  if (headResult.exitCode === 0 && !headStdout) {
    return { status: 'ambiguous-absence', headSha: null };
  }
  if (headResult.exitCode !== 0) {
    return { status: 'indeterminate', headSha: null };
  }
  return { status: 'present', headSha: headStdout };
}

/**
 * #4588 (decision A2) — observe, from documented git metadata, whether the
 * harness forks its worktrees from the orchestrator HEAD.
 *
 * Substrate: the harness's own prior worktrees. TWO LEGS answer the question —
 * a cache read, then a live probe on a miss — and they are not the same kind
 * of evidence.
 *
 * The LIVE PROBE looks for a linked worktree under
 * `<repo>/.claude/worktrees/agent-*` that is still CLEAN (no tracked
 * modifications; untracked review notes are fine) and whose HEAD equals the
 * current orchestrator HEAD. That is POSITIVE evidence of fork-from-HEAD: an
 * origin/HEAD fork would ordinarily have landed on an older commit once the
 * orchestrator advanced. It is the only configuration that counts — every
 * other observation (dirty worktree, different HEAD, no worktrees, git
 * failure) is inconclusive and fails closed to the caller's existing flow.
 *
 * The CACHE leg looks at no worktree at all. It replays this function's OWN
 * earlier conclusion for the same orchestrator HEAD, so a hit inherits whatever
 * that earlier probe was worth and re-examines nothing — not the worktree, not
 * even whether one still exists.
 *
 * EVIDENCE, NOT PROOF, AND THE LIVE PROBE FAILS IN TWO INDEPENDENT WAYS
 * (#4921). What it reads is a worktree's PRESENT state — is it clean, where is
 * its HEAD — and none of `worktree list --porcelain`, `status --porcelain` or
 * `rev-parse HEAD` carries provenance.
 *
 *   1. It cannot say WHICH CREATOR. Where the harness is the only creator that
 *      is a distinction without a difference; where a `WorktreeCreate` hook is
 *      configured it is not, because a worktree the plain harness left behind
 *      BEFORE the hook existed — with HEAD unmoved since — is
 *      indistinguishable from one the hook made.
 *   2. It cannot say WHAT IT WAS FORKED FROM either. A worktree created from an
 *      older base and since `git checkout --detach`ed onto the orchestrator
 *      HEAD is clean, sits at HEAD, and satisfies the probe identically. Note
 *      the shape of this one precisely: the worktree's own reflog DOES retain
 *      that original checkout, so the information is not lost — the probe just
 *      does not consult it, and #4868 did not design it to. Inherited from
 *      #4868 rather than introduced here, and accepted there for the no-hook
 *      case; stated so the strength of the signal is not overread.
 *
 * Both are reasons the observation is inadmissible once a hook is in the
 * creation path, and the cache leg is a third, since it re-examines nothing at
 * all. So the caller withholds it entirely under that interlock rather than
 * re-keying it; see `hookWithheldHeadTrust` in evaluateWorktreeBaseDegrade.
 *
 * The verdict is cached at `<cwd>/.gsd/harness-fork-probe.json` keyed by the
 * orchestrator HEAD (the decision's keying): trusted only while the
 * orchestrator HEAD is unchanged; any HEAD move re-probes. Cache I/O failures
 * are swallowed — the probe re-runs instead (#3659 fail-closed posture).
 */
export function observeHarnessForkFromHead(deps: {
  execGit?: ExecGitFn;
  cwd?: string;
  headSha: string;
  stateRead?: (file: string) => string | null;
  stateWrite?: (file: string, content: string) => void;
}): { confirmed: boolean; source: 'cache' | 'probe' | 'none'; worktreePath: string | null; worktreeHead: string | null } {
  const execGit = deps.execGit ?? execGitSeam;
  const cwd = deps.cwd ?? '.';
  const cacheFile = path.join(cwd, '.gsd', 'harness-fork-probe.json');
  const stateRead = deps.stateRead ?? ((file: string) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  });
  const stateWrite = deps.stateWrite ?? ((file: string, content: string) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    } catch {
      // A cache write must never break the check that produced the verdict.
    }
  });

  // 1. Cache — trusted only while the orchestrator HEAD is unchanged.
  try {
    const raw = stateRead(cacheFile);
    if (raw) {
      const cached = JSON.parse(raw) as { headSha?: string; verdict?: string; worktreePath?: string | null; worktreeHead?: string | null };
      if (cached.headSha === deps.headSha && cached.verdict === 'fork-from-head-confirmed') {
        return { confirmed: true, source: 'cache', worktreePath: cached.worktreePath ?? null, worktreeHead: cached.worktreeHead ?? null };
      }
    }
  } catch {
    // Corrupt cache — re-probe (fail open INTO the probe, which itself fails closed).
  }

  // 2. Probe: list linked worktrees, keep the harness's own, require a clean
  //    one whose HEAD equals the orchestrator HEAD. ANY failure — timeout,
  //    non-zero exit, or a throwing execGit — is an inconclusive observation,
  //    never a crash: the caller falls through to its existing flow (#4588).
  try {
    const list = execGit(['worktree', 'list', '--porcelain'], { cwd });
    if (isExecGitTimeout(list) || list.exitCode !== 0) {
      return { confirmed: false, source: 'none', worktreePath: null, worktreeHead: null };
    }
    const candidates = String(list.stdout || '')
      .split('\n\n')
      .map((block) => block.split('\n').find((l) => l.startsWith('worktree '))?.slice('worktree '.length).trim())
      .filter((p): p is string => !!p && p.includes('/.claude/worktrees/agent-'));
    for (const wtPath of candidates) {
      const status = execGit(['-C', wtPath, 'status', '--porcelain'], { cwd });
      if (isExecGitTimeout(status) || status.exitCode !== 0) continue;
      const trackedDirty = String(status.stdout || '')
        .split('\n')
        .some((l) => l.trim() !== '' && !l.startsWith('?? '));
      if (trackedDirty) continue;
      const wtHeadResult = execGit(['-C', wtPath, 'rev-parse', 'HEAD'], { cwd });
      if (isExecGitTimeout(wtHeadResult) || wtHeadResult.exitCode !== 0) continue;
      const wtHead = wtHeadResult.stdout ? wtHeadResult.stdout.trim() : '';
      if (wtHead && wtHead === deps.headSha) {
        try {
          stateWrite(cacheFile, `${JSON.stringify({
            headSha: deps.headSha,
            worktreePath: wtPath,
            worktreeHead: wtHead,
            verdict: 'fork-from-head-confirmed',
            probedAt: new Date().toISOString(),
          })}\n`);
        } catch {
          // Cache write is best-effort; the verdict stands for this dispatch.
        }
        return { confirmed: true, source: 'probe', worktreePath: wtPath, worktreeHead: wtHead };
      }
    }
  } catch {
    // A throwing execGit (unexpected stub shape, seam surprise) is an
    // inconclusive observation, not a crash — the #3659 comparison governs.
  }
  return { confirmed: false, source: 'none', worktreePath: null, worktreeHead: null };
}

/**
 * Evaluates whether the current worktree HEAD has diverged from the fork base
 * a 'fresh' parallel worktree would be created from — `origin/HEAD` when the
 * fork base is inferred, or the base a worktree was actually observed to have
 * when the caller supplies one (#4588).
 *
 * Returns a structured result with shouldDegrade, reason, and a user-visible
 * message when degradation is warranted.
 */
export function evaluateWorktreeBaseDegrade(deps?: {
  execGit?: ExecGitFn;
  effectiveBaseRef?: string | null;
  cwd?: string;
  /**
   * Who creates the isolated worktree (#3659). 'harness-worktree' (default):
   * the runtime harness forks it. 'orchestrator-worktree': GSD itself runs
   * `git worktree add <path> <start-point>` with the orchestrator HEAD.
   * `worktree.baseRef:"head"` is honored by the orchestrator by construction
   * and by the Claude Code harness as measured across all three settings
   * layers and three OSes (#4588; the #48 finding that the harness did not
   * read the setting predates upstream claude-code#54940); Cursor, the other
   * shipped harness-worktree host, is unmeasured. The mode is kept
   * on the interface because the two paths stay distinct in the dispatch
   * step and future host descriptors may differ again.
   */
  isolationMode?: BaseCheckIsolationMode;
  /**
   * #4588 (decision A2) cache I/O for the observed fork-from-HEAD verdict.
   * Defaults read/write `<cwd>/.gsd/harness-fork-probe.json`; inject for tests.
   * The cache is keyed by the orchestrator HEAD and is trusted only while that
   * HEAD is unchanged.
   */
  probeStateRead?: (file: string) => string | null;
  probeStateWrite?: (file: string, content: string) => void;
  /**
   * The fork base a worktree created by this host was actually observed to
   * have — `git rev-parse HEAD` inside a freshly created isolated worktree,
   * before any commit (#4588). When present it REPLACES the `origin/HEAD`
   * inference as the fork side of the comparison, so the verdict reports a
   * measurement rather than a belief about the harness, and `head` no longer
   * short-circuits: a mismatch under `head` means the worktree was not forked
   * from HEAD despite the setting and degrades with
   * `baseref-head-ignored-by-harness`. Must be a full 40- or 64-hex sha (case
   * folded); any other non-blank string, and any non-string value (a number,
   * object or boolean), throws a TypeError — an abbreviation that can never
   * equal the full HEAD would otherwise always degrade, and a non-string must
   * not read as "no observation". Absent (null/undefined) or blank (the
   * default) → the inference path, unchanged.
   */
  observedForkBase?: string | null;
  /**
   * A settings layer declaring a Claude Code `WorktreeCreate` hook, or one that does not
   * parse (findWorktreeCreateHook, #4588). Consulted only under `harness-worktree` with no
   * observation: there a hook, not the harness, creates the worktree and `worktree.baseRef`
   * is not applied, so `"head"` does not short-circuit and the inferred comparison runs; a
   * mismatch degrades with `baseref-head-bypassed-by-hook`. With `"head"` set it also
   * withholds the #4868 prior-worktree observation, which cannot be attributed to the hook
   * (#4921): on a hook host only `observedForkBase` restores a trusted verdict. Ignored under
   * `orchestrator-worktree` (GSD's own `git worktree add` never runs a Claude Code hook) and
   * whenever an observation is supplied (the measurement already sees where a hook forked).
   */
  worktreeCreateHook?: WorktreeCreateHookFinding | null;
}): {
  shouldDegrade: boolean;
  reason: string;
  message: string | null;
  headSha: string | null;
  forkRef: string | null;
  forkSha: string | null;
  /**
   * Only meaningful when `reason === 'no-head'`; `null` for every other
   * reason. Distinguishes the two no-head causes: `true` for exit 128 —
   * git's definitive "no resolvable HEAD here" answer, which DEGRADES as of
   * #4734 (a worktree can never be created; the maintainer brief on #4734
   * answered the previously-open product question). `false` for exit 0 with
   * empty stdout — git completed but did NOT give a confirmed answer; that
   * outcome stays `shouldDegrade:false` (pinned by an existing regression
   * guard; the product question remains open, #3050/#3057 B8).
   */
  headAbsenceVerified: boolean | null;
} {
  const execGit: ExecGitFn = deps?.execGit ?? execGitSeam;
  const cwd = deps?.cwd;
  const cwdOpts = cwd ? { cwd } : {};

  const baseRefHead = deps?.effectiveBaseRef === 'head';
  const observedRaw = deps?.observedForkBase;
  // Only a string or an explicit absence is a legal observation. A number, object or
  // boolean is a programmer error and must not be read as "no observation" — the same
  // TypeError shape applyWorktreeBaseRef uses for a non-object (P4.6 review, round 2).
  if (observedRaw != null && typeof observedRaw !== 'string') {
    throw new TypeError(`evaluateWorktreeBaseDegrade: ${MSG_OBSERVED_FORK_BASE_INVALID}, got ${typeof observedRaw}`);
  }
  const observedTrimmed = typeof observedRaw === 'string' ? observedRaw.trim().toLowerCase() : '';
  if (observedTrimmed && !FULL_SHA_RE.test(observedTrimmed)) {
    throw new TypeError(`evaluateWorktreeBaseDegrade: ${MSG_OBSERVED_FORK_BASE_INVALID}, got ${JSON.stringify(observedRaw)}`);
  }
  const observedForkBase: string | null = observedTrimmed || null;

  // a. baseRef 'head' with no observation: the fork base IS the orchestrator
  // HEAD, in both isolation modes. orchestrator-worktree: GSD runs
  // `git worktree add <path> <start-point>` with the orchestrator HEAD, so it
  // holds by construction (#3659). harness-worktree: the harness honors the
  // setting — measured on current Claude Code from the project-local,
  // project-shared and user/global layers on macOS, Windows and Linux (#4588).
  // The former harness-mode fall-through rested on #48's finding that the
  // harness did not read the setting; that was true of the harness at the time
  // and was fixed upstream (claude-code#54940), but the check inferred the
  // fork base from the setting's value alone and so could not notice. It is
  // not replaced with a version cutover: a host that does not honor `head`
  // forks from somewhere else, and the spawn-time `worktree_branch_check`
  // guard halts that executor at exit 42 before it commits — the
  // observation-based check that already exists. A caller holding that
  // observation passes it as `observedForkBase` and lands in c/d below, where
  // a mismatch under `head` degrades with `baseref-head-ignored-by-harness`.
  // Any non-"head" value (including "fresh" and absent/null) keeps
  // fresh/origin-HEAD semantics and is evaluated against origin/HEAD as
  // before — with the setting absent the harness does fork from origin/HEAD,
  // so that degrade is a correct reading, not this bug. Measured on Claude
  // Code only: Cursor also declares `harness-worktree` and is unmeasured, so
  // there the trust rests on the exit-42 backstop alone until someone reads a
  // worktree's HEAD on that host. (#683, #48, #3659, #4588.)
  //
  // The one exception is a Claude Code `WorktreeCreate` hook under harness-worktree
  // (#4588): the hook creates the agent worktree from whatever directory it emits and the
  // harness does not apply `worktree.baseRef` on that path, so the measurement above does
  // not cover it. The short-circuit is withheld and the origin/HEAD inference below runs,
  // as for a host without the setting; a mismatch degrades with
  // `baseref-head-bypassed-by-hook`, and the ONLY thing that restores a trusted verdict
  // there is an explicit `--observed-fork-base` measurement of this dispatch. b2's
  // prior-worktree observation deliberately does NOT restore it — see
  // `hookWithheldHeadTrust` below (#4868, #4881, #4921). orchestrator-worktree is
  // unaffected — GSD runs `git worktree add` itself and no Claude Code hook is in that
  // path.
  const hookFinding: WorktreeCreateHookFinding | null = deps?.worktreeCreateHook ?? null;
  const hookBypassesBaseRef = hookFinding !== null && (deps?.isolationMode ?? 'harness-worktree') === 'harness-worktree';
  // The interlock's fail-closed half, scoped to exactly the case branch a. declined to
  // trust: `"head"` is set AND a hook (or an unparseable layer) is in the harness's
  // worktree-creation path. It is deliberately NOT `hookBypassesBaseRef` alone — with no
  // `"head"` setting, b2 is #4868's own arm and this PR does not re-scope it.
  const hookWithheldHeadTrust = baseRefHead && hookBypassesBaseRef;
  if (baseRefHead && observedForkBase === null && !hookBypassesBaseRef) {
    return { shouldDegrade: false, reason: 'baseref-head', message: null, headSha: null, forkRef: null, forkSha: null, headAbsenceVerified: null };
  }

  // b. Resolve HEAD sha — through the single classification owner (#4734).
  const head = classifyGitHead({ execGit, cwd });
  if (head.status === 'indeterminate') {
    // A timeout, git missing (exit 127), or any other non-128 non-success is
    // NOT a definitive answer from git — fail closed (#3050).
    return { shouldDegrade: true, reason: 'head-unresolvable', message: MSG_HEAD_UNRESOLVABLE, headSha: null, forkRef: null, forkSha: null, headAbsenceVerified: null };
  }
  if (head.status === 'definitive-absence') {
    // Exit 128 is git's definitive "no resolvable HEAD here" answer — not a
    // git repository, or a repository with no commits. In either case a
    // harness worktree can NEVER be created, so demanding worktree isolation
    // blocked every dispatch from e.g. a multi-repo workspace root (#4734).
    // This wires the verdict `headAbsenceVerified` (#3057 B8) was added to
    // enable; the maintainer brief on #4734 answers the previously-open
    // product question: the definitive case degrades.
    return { shouldDegrade: true, reason: 'no-head', message: MSG_NO_GIT_REPOSITORY, headSha: null, forkRef: null, forkSha: null, headAbsenceVerified: true };
  }
  if (head.status === 'ambiguous-absence') {
    // Exit 0 with empty stdout is pinned as benign no-degrade by an existing
    // regression guard (tests/worktree-base-ref.test.cjs — "git rev-parse HEAD
    // returns empty stdout"). Unlike the exit-128 case above, git did NOT
    // give a definitive "no HEAD" answer here — `headAbsenceVerified:false`
    // names that gap explicitly (#3057 B8; the product question of whether
    // this SHOULD degrade is unchanged and still open).
    return { shouldDegrade: false, reason: 'no-head', message: null, headSha: null, forkRef: null, forkSha: null, headAbsenceVerified: false };
  }
  const headSha = head.headSha;

  // b2. #4868 (#4588 decision A2): OBSERVED fork-from-HEAD confirmation. A
  // clean prior harness worktree sitting exactly at the orchestrator HEAD is
  // positive evidence the harness forks from HEAD — in harness mode that
  // supersedes the origin/HEAD comparison for this dispatch (the stale
  // origin/HEAD the comparison would degrade on is not where the harness
  // forks). Fail-closed: every non-confirming observation falls through to
  // the comparison below. Since #4881 this step is reached only when branch a
  // did NOT trust the setting: the setting is absent or not "head", or a
  // WorktreeCreate hook withheld the trust — and in that second case the
  // observation is NOT consulted at all (`hookWithheldHeadTrust`), because it
  // cannot be attributed to the hook. The evidence is a worktree sitting at
  // HEAD; nothing on disk records WHICH creator left it there, so a clean
  // worktree the plain harness created BEFORE the hook was configured, with
  // HEAD unmoved since, is indistinguishable from one the hook created. Keying
  // the cache by hook configuration does not close that: the cache is only one
  // of the two legs, and a cache miss falls through to the live probe, which
  // re-finds the same stale worktree and re-confirms. Under a hook the only
  // admissible positive signal is an explicit `--observed-fork-base`
  // measurement of THIS dispatch, which lands in c/d below; absent one the
  // inferred comparison runs and a mismatch degrades with
  // `baseref-head-bypassed-by-hook`, leaving the spawn-time exit-42 guard as
  // the backstop. That keeps the interlock fail-closed end to end.
  // This step is skipped for a second, unrelated reason when the caller
  // supplies `observedForkBase`: an explicit measurement of this dispatch's
  // fork base outranks an inference from a prior worktree, and the two must
  // not disagree silently. The mode gate excludes orchestrator-worktree (no
  // harness, no hook, nothing to observe), and probeStateRead/Write default to
  // the .gsd cache file under cwd. With no `"head"` setting the #4868 arm is
  // unchanged, hook or not — that trust predates this PR and is not re-scoped
  // here (#4921 round 1).
  if (observedForkBase === null && !hookWithheldHeadTrust && (deps?.isolationMode ?? 'harness-worktree') === 'harness-worktree') {
    const observed = observeHarnessForkFromHead({
      execGit,
      cwd: deps?.cwd,
      headSha,
      stateRead: deps?.probeStateRead,
      stateWrite: deps?.probeStateWrite,
    });
    if (observed.confirmed) {
      return {
        shouldDegrade: false,
        reason: 'fork-from-head-observed',
        message: null,
        headSha,
        forkRef: null,
        forkSha: null,
        headAbsenceVerified: null,
      };
    }
  }

  // c. Resolve fork base. An observation wins outright: it is what a worktree
  // this host created actually forked from, so there is nothing to infer
  // (#4588). Otherwise infer origin/HEAD — what a 'fresh' worktree forks from.
  let forkRef: string | null = null;
  let forkSha: string | null = null;

  if (observedForkBase !== null) {
    forkRef = FORK_REF_OBSERVED;
    forkSha = observedForkBase;
  } else {
    // Try direct origin/HEAD rev-parse first.
    const directResult = execGit(['rev-parse', '--verify', '--quiet', 'origin/HEAD'], cwdOpts);
    const directStdout = directResult.stdout ? directResult.stdout.trim() : '';
    if (directResult.exitCode === 0 && directStdout) {
      forkRef = 'origin/HEAD';
      forkSha = directStdout;
    } else {
      // Fall back via symbolic-ref → refs/remotes/origin/HEAD
      const symResult = execGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwdOpts);
      const symStdout = symResult.stdout ? symResult.stdout.trim() : '';
      if (symResult.exitCode === 0 && symStdout) {
        const ref = symStdout;
        const symShaResult = execGit(['rev-parse', '--verify', '--quiet', ref], cwdOpts);
        const symShaStdout = symShaResult.stdout ? symShaResult.stdout.trim() : '';
        if (symShaResult.exitCode === 0 && symShaStdout) {
          // Strip leading 'refs/remotes/' to get e.g. 'origin/next'
          forkRef = ref.replace(/^refs\/remotes\//, '');
          forkSha = symShaStdout;
        }
      }
    }
  }

  // d. Evaluate.
  if (forkSha === null) {
    return { shouldDegrade: true, reason: 'fork-ref-unknown', message: MSG_UNKNOWN, headSha, forkRef: null, forkSha: null, headAbsenceVerified: null };
  }
  if (forkSha === headSha) {
    const reason = forkRef === FORK_REF_OBSERVED ? 'observed-fork-matches-head' : 'head-matches-fork';
    return { shouldDegrade: false, reason, message: null, headSha, forkRef, forkSha, headAbsenceVerified: null };
  }
  if (baseRefHead && observedForkBase === null && hookFinding !== null) {
    // Reachable only through the hook interlock in a.: "head" was not trusted because a
    // WorktreeCreate hook (or an unparseable settings layer) is in the harness's path, b2
    // was withheld there (`hookWithheldHeadTrust` — a prior worktree cannot be attributed
    // to the hook), and HEAD differs from the inferred fork base (#4588, #4881, #4921).
    // So this is now the unconditional harness-mode verdict for a hook host with "head"
    // set, a diverged HEAD and no `--observed-fork-base`. The inferred comparison is the one
    // this check made in harness mode before #4588 — it is not a measurement of the hook, so
    // a match above (head-matches-fork) does not prove the hook forks from HEAD either; the
    // spawn-time exit-42 guard stays the backstop for that case, and it halts even in a
    // hook-emitted directory that is not a git worktree (its branch check fails first).
    const message = buildMsgBaserefHeadHookBypass(headSha, forkRef, forkSha, hookFinding);
    return { shouldDegrade: true, reason: 'baseref-head-bypassed-by-hook', message, headSha, forkRef, forkSha, headAbsenceVerified: null };
  }
  if (baseRefHead) {
    // Reachable only with an observation (a. returned otherwise): the setting
    // asked for HEAD and the measured fork base is something else — the
    // existing degrade-and-warn, now reporting a measurement (#4588).
    const message = buildMsgBaserefHeadIgnored(headSha, forkSha);
    return { shouldDegrade: true, reason: 'baseref-head-ignored-by-harness', message, headSha, forkRef, forkSha, headAbsenceVerified: null };
  }
  const message = buildMsgDiverged(headSha, forkRef, forkSha);
  return { shouldDegrade: true, reason: 'head-diverged-from-fork', message, headSha, forkRef, forkSha, headAbsenceVerified: null };
}
