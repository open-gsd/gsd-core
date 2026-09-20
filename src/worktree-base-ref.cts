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

// ─── Message constants (verbatim — downstream docs/tests depend on these) ─────

function buildMsgDiverged(headSha: string | null, forkRef: string | null, forkSha: string | null): string {
  return `⚠ Worktree base mismatch: HEAD (${shortSha(headSha)}) differs from ${forkRef} (${shortSha(forkSha)}). Running this phase sequentially on the main working tree. Parallel worktrees return once HEAD is merged/pushed so ${forkRef} matches it. (worktree.baseRef:"head" applies only where GSD itself creates the worktree — the runtime harness does not read it; #48, #3659.)`;
}

const MSG_UNKNOWN = `⚠ Cannot determine the worktree fork base (origin/HEAD unresolved). Running this phase sequentially on the main working tree to avoid a base mismatch. Parallel worktrees return once origin/HEAD resolves and matches HEAD. See #683, #3659.`;

function buildMsgBaserefHeadIgnored(headSha: string | null, forkRef: string | null, forkSha: string | null): string {
  return `⚠ Worktree base mismatch: worktree.baseRef:"head" is set, but the runtime harness does not honor it for isolated dispatch — the fork base stays ${forkRef} (${shortSha(forkSha)}) while HEAD is ${shortSha(headSha)} (#48; upstream claude-code#44965). Running this phase sequentially on the main working tree. Parallel worktrees return once HEAD is merged/pushed so ${forkRef} matches it, or on runtimes where GSD itself manages worktree creation. See #3659.`;
}

const MSG_HEAD_UNRESOLVABLE = `⚠ Cannot determine the worktree base (git rev-parse HEAD did not return a definitive answer). Running this phase sequentially on the main working tree to avoid an unverified base mismatch. Note: worktree.baseRef:"head" silences this check only where GSD itself creates the worktree (orchestrator-managed runtimes) — in harness mode it never applied (#48, #3659). Retry; if it persists, check for a stalled filesystem mount or a stale git index lock (.git/index.lock). See #683, #3050.`;

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
  const claudeDir = path.join(cwd, '.claude');
  const userClaudeDir = Object.prototype.hasOwnProperty.call(deps ?? {}, 'userClaudeDir')
    ? (deps as { userClaudeDir?: string | null }).userClaudeDir
    : getGlobalConfigDir('claude');
  const effectiveBaseRef = resolveEffectiveBaseRef(
    claudeDir,
    deps?.readFile ? { readFile: deps.readFile } : undefined,
    userClaudeDir
  );
  const result = evaluateWorktreeBaseDegrade({
    cwd,
    effectiveBaseRef,
    execGit: deps?.execGit,
    isolationMode,
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
 * Substrate: the harness's own prior worktrees. A linked worktree under
 * `<repo>/.claude/worktrees/agent-*` that is still CLEAN (no tracked
 * modifications; untracked review notes are fine) and whose HEAD equals the
 * current orchestrator HEAD can only exist if the harness forked from HEAD
 * after that commit was made — an origin/HEAD fork would have landed on an
 * older commit once the orchestrator advanced. That combination is therefore
 * POSITIVE evidence of fork-from-HEAD, and it is the only configuration that
 * counts: every other observation (dirty worktree, different HEAD, no
 * worktrees, git failure) is inconclusive and fails closed to the caller's
 * existing flow.
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
 * (origin/HEAD) that the Claude Code harness would use when creating a 'fresh'
 * parallel worktree.
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
   * the runtime harness forks it and does NOT route through project-settings
   * baseRef (#48, verified 5/5; upstream claude-code#44965) — 'head' must not
   * suppress the comparison. 'orchestrator-worktree': GSD itself runs
   * `git worktree add <path> <start-point>` with the orchestrator HEAD, so
   * 'head' is honored by construction and still suppresses.
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

  // a. baseRef 'head' suppresses ONLY where GSD controls the fork start-point
  // (#3659). The former unconditional suppress trusted the harness to honor the
  // setting; #48 verified 5/5 that the Agent-isolation dispatch path never
  // routes through project settings (upstream claude-code#44965), so in
  // harness mode the fork base is always origin/HEAD and 'head' must fall
  // through to the same comparison the fresh path runs. In
  // orchestrator-worktree mode GSD itself runs `git worktree add <path>
  // <start-point>` with the orchestrator HEAD — 'head' is honored by
  // construction there and the suppress is correct. Any non-"head" value
  // (including "fresh" and absent/null) has fresh/origin-HEAD semantics and is
  // evaluated against origin/HEAD as before. (Reference: #683, #48, #3659.)
  const headIgnoredByHarness = deps?.effectiveBaseRef === 'head';
  if (headIgnoredByHarness && (deps?.isolationMode ?? 'harness-worktree') === 'orchestrator-worktree') {
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

  // b2. #4588 (decision A2): OBSERVED fork-from-HEAD confirmation. A clean
  // prior harness worktree sitting exactly at the orchestrator HEAD is
  // positive evidence the harness forks from HEAD — in harness mode that
  // supersedes the origin/HEAD comparison for this dispatch (the stale
  // origin/HEAD the comparison would degrade on is not where the harness
  // forks). Fail-closed: every non-confirming observation falls through to
  // the exact pre-#4588 flow below. The mode gate below (not branch a)
  // excludes orchestrator-worktree mode — branch a only returns when
  // worktree.baseRef:"head" is set — and probeStateRead/Write default to the
  // .gsd cache file under cwd.
  if ((deps?.isolationMode ?? 'harness-worktree') === 'harness-worktree') {
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

  // c. Resolve fork base (what the harness forks 'fresh' worktrees from = origin/HEAD).
  let forkRef: string | null = null;
  let forkSha: string | null = null;

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

  // d. Evaluate.
  if (forkSha === null) {
    return { shouldDegrade: true, reason: 'fork-ref-unknown', message: MSG_UNKNOWN, headSha, forkRef: null, forkSha: null, headAbsenceVerified: null };
  }
  if (forkSha === headSha) {
    return { shouldDegrade: false, reason: 'head-matches-fork', message: null, headSha, forkRef, forkSha, headAbsenceVerified: null };
  }
  if (headIgnoredByHarness) {
    const message = buildMsgBaserefHeadIgnored(headSha, forkRef, forkSha);
    return { shouldDegrade: true, reason: 'baseref-head-ignored-by-harness', message, headSha, forkRef, forkSha, headAbsenceVerified: null };
  }
  const message = buildMsgDiverged(headSha, forkRef, forkSha);
  return { shouldDegrade: true, reason: 'head-diverged-from-fork', message, headSha, forkRef, forkSha, headAbsenceVerified: null };
}
