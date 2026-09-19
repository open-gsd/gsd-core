/**
 * Git Scope-Commit Selector — issue #4661.
 *
 * Answers one question for `/gsd:undo`: which commits in a revision range
 * DECLARE a given phase or plan as their conventional-commit scope?
 *
 * It replaces two selectors in `gsd-core/workflows/undo.md` that interpolated
 * the requested id into an unanchored ERE over `git log --oneline` text and fed
 * the result to `git revert --no-commit`. That shape over-selected four ways
 * (a dotted id's `.` is a wildcard; `03+` retargets to phase 03; a subject that
 * merely QUOTES another scope matches; metacharacters are live) and its obvious
 * repair — anchor and escape — under-selects `fixup!` / `Revert "` subjects
 * into a silent rc=0 partial revert.
 *
 * The rule here is that the id is never turned into a pattern at all:
 *
 *   1. The record shape is pinned (`--no-color`, an explicit `--format`), so
 *      `color.ui=always` and `log.decorate` cannot change what is parsed.
 *   2. Git's own autosquash prefixes, `Revert "` and `Reapply "` are stripped, so a
 *      fixup, a revert, or a re-applied revert of a scoped commit is read as
 *      belonging to that scope.
 *   3. The scope is EXTRACTED with the repository's single conventional-header
 *      matcher (`scripts/release-notes/conventional-title.cjs`, #1549) — not a
 *      fifth hand-rolled copy of that grammar. Its `^` anchor is what makes a
 *      quoted `feat(03-01):` later in a subject invisible.
 *   4. Extracted scope and requested id are compared as VALUES. A numeric-shaped
 *      id is compared with `comparePhaseNum` — the equality `phase.cts` already
 *      uses, tolerant of padding in every dotted segment and of letter case —
 *      only after a strict shape check that also turns away digit runs too long
 *      for it to compare exactly, because the phase-id helpers are
 *      deliberately forgiving of malformed input (`03+` normalises to `03`).
 *      Anything else is compared as a literal string, so `03+` selects only a
 *      scope literally named `03+`.
 *
 * Out of scope, deliberately: the RANGE searched. The caller supplies it;
 * `undo.md` derives it from the phase directory (#4465 / #4472).
 *
 * A limit of any subject-based selector, this one included: a commit whose
 * subject declares no scope is invisible to it. `git merge --squash` writes
 * `Squashed commit of the following:` and puts the scoped subjects in the BODY,
 * so phase work landed that way is not selected — as it was not before.
 *
 * Pure/testable: the git runner and both writers are injectable via `deps`.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
import { execGit as execGitSeam } from './shell-command-projection.cjs';

// The conventional-header grammar has exactly one owner. It lives under
// scripts/ because the PR-title CI gate loads it straight after checkout, with
// no install and no build; the installer ships it beside
// scripts/fix-slash-commands.cjs for the same reason that file is shipped
// (#1223): a compiled module requires it at load time.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const conventionalTitle = require('../../../scripts/release-notes/conventional-title.cjs') as {
  HEADER_RE: RegExp;
};

const { error, ERROR_REASON } = io;
const { comparePhaseNum, CASE_FLEXIBLE_PHASE_NUMBER_TOKEN_SOURCE } = phaseIdMod;

type ExecGitFn = typeof execGitSeam;

export interface ScopeCommitsDeps {
  /** Override the git runner (default: execGit from shell-command-projection) */
  execGit?: ExecGitFn;
  /** Inject the stdout writer (default: process.stdout.write) */
  write?: (s: string) => void;
}

export type ScopeMode = 'phase' | 'plan';

export interface ScopeTarget {
  mode: ScopeMode;
  id: string;
}

export interface ScopedCommit {
  sha: string;
  subject: string;
}

/**
 * `<phase>[-<plan>]` where the phase is an integer with an optional single
 * letter suffix and optional dotted integer sub-segments (`03`, `3A`, `23.1.2`)
 * and the plan is an integer. The phase half is the phase-id owner's own token
 * grammar, not a copy of it (ADR-2121; tests/phase-id-drift-guard.test.cjs fails a
 * copy). Anchored at both ends: this is the gate that decides whether
 * `comparePhaseNum` may be trusted with the token.
 */
const NUMERIC_SCOPE_RE = new RegExp(`^(${CASE_FLEXIBLE_PHASE_NUMBER_TOKEN_SOURCE})(?:-(\\d+))?$`);

/**
 * Prefixes that wrap another commit's subject. The three autosquash tokens are
 * git's own (`git help rebase`: "squash! ", "fixup! ", "amend! "); `Revert "`
 * is what `git revert` writes, and `Reapply "` is what it writes (git >= 2.43)
 * when the commit being reverted is itself a revert. They nest (`fixup! fixup! …`,
 * `Revert "Reapply "…""`), so stripping repeats until none is left.
 */
const WRAPPER_PREFIXES = ['fixup! ', 'squash! ', 'amend! ', 'Revert "', 'Reapply "'];

export function stripWrapperPrefixes(subject: string): string {
  let rest = subject;
  for (;;) {
    const prefix = WRAPPER_PREFIXES.find((p) => rest.startsWith(p));
    if (prefix === undefined) return rest;
    rest = rest.slice(prefix.length);
  }
}

/**
 * The scope a subject DECLARES — the parenthesised token of a conventional
 * header at the start of the (unwrapped) subject — or null when it declares
 * none. A scope quoted later in the subject is not a declaration.
 */
export function declaredScope(subject: string): string | null {
  const m = conventionalTitle.HEADER_RE.exec(stripWrapperPrefixes(subject));
  if (!m || !m[2]) return null;
  return m[2].slice(1, -1);
}

interface NumericScope {
  phase: string;
  /** Plan digits with leading zeros removed — a string, never a Number (see below). */
  plan: string | null;
}

function parseNumericScope(token: string): NumericScope | null {
  const m = NUMERIC_SCOPE_RE.exec(token);
  if (!m) return null;
  // comparePhaseNum parses each segment as a Number, which collapses distinct integers past
  // 2^53 (`9007199254740992` === `…993`). A token carrying a digit run it cannot compare
  // exactly is not numeric-shaped for our purposes: it falls to the literal arm, where
  // equality is string equality.
  if (/\d{16,}/.test(m[1])) return null;
  // Compared as digit strings: `Number` collapses distinct integers past 2^53, and two
  // plans that compare equal here are two plans handed to `git revert` as one.
  const plan = m[2] === undefined ? null : m[2].replace(/^0+(?=\d)/, '');
  return { phase: m[1], plan };
}

/** Does `scope` (as declared by a commit) belong to `target`? */
export function scopeMatchesTarget(scope: string, target: ScopeTarget): boolean {
  const want = parseNumericScope(target.id);
  if (want) {
    const have = parseNumericScope(scope);
    if (!have || comparePhaseNum(have.phase, want.phase) !== 0) return false;
    if (target.mode === 'phase') return want.plan === null;
    return want.plan !== null && have.plan === want.plan;
  }
  // Not numeric-shaped (a custom id, or a malformed one such as `03+`): the id
  // is a literal, never an operator. Phase mode still admits the `-<plan>` tail
  // the numeric arm admits, so a custom-id project keeps selecting its plans.
  if (scope === target.id) return true;
  // An id ending in `-` has no plan tail to admit: `foo-` must not claim `foo--01`.
  if (target.mode !== 'phase' || target.id.endsWith('-') || !scope.startsWith(`${target.id}-`)) return false;
  return /^\d+$/.test(scope.slice(target.id.length + 1));
}

/**
 * Where to read the log. gsd-tools hands routers the resolved PROJECT ROOT, which for a
 * linked worktree is the MAIN worktree — a different HEAD from the one the caller derived
 * `--range` against. So: when the caller stands in a worktree of the SAME repository as the
 * resolved root, read the caller's; otherwise (an explicit `--cwd` elsewhere, or a host
 * process in some unrelated directory) read the resolved one. Decided by asking git, not
 * by inspecting argv.
 */
export function resolveLogDir(resolvedCwd: string, callerCwd: string, deps?: ScopeCommitsDeps): string {
  if (resolvedCwd === callerCwd) return resolvedCwd;
  const execGit = deps?.execGit ?? execGitSeam;
  const commonDir = (dir: string): string | null => {
    const r = execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir });
    return r.exitCode === 0 && r.stdout ? r.stdout : null;
  };
  const caller = commonDir(callerCwd);
  return caller !== null && caller === commonDir(resolvedCwd) ? callerCwd : resolvedCwd;
}

export function selectScopedCommits(
  cwd: string,
  target: ScopeTarget,
  range: string,
  deps?: ScopeCommitsDeps
): ScopedCommit[] {
  const execGit = deps?.execGit ?? execGitSeam;
  // `--end-of-options` keeps a range that begins with `-` from being read as a flag.
  const result = execGit(
    ['log', '--no-merges', '--no-color', '--format=%h%x09%s', '--end-of-options', range],
    { cwd }
  );
  if (result.exitCode !== 0) {
    error(
      `git scope-commits: git log failed for range '${range}': ${result.stderr || `exit ${result.exitCode}`}`,
      ERROR_REASON.USAGE
    );
  }
  const selected: ScopedCommit[] = [];
  for (const line of result.stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const subject = line.slice(tab + 1);
    const scope = declaredScope(subject);
    if (scope !== null && scopeMatchesTarget(scope, target)) {
      selected.push({ sha: line.slice(0, tab), subject });
    }
  }
  return selected;
}

const USAGE = 'Usage: git scope-commits (--phase <id> | --plan <id>) --range <rev-range>';

/**
 * CLI entry: prints one `<abbrev-sha> <subject>` line per selected commit,
 * newest first — the shape `git log --oneline` gave the workflow before. An
 * empty selection prints nothing and exits 0; the workflow's own empty check
 * owns that case.
 */
export function cmdGitScopeCommits(cwd: string, args: string[], deps?: ScopeCommitsDeps): ScopedCommit[] {
  let target: ScopeTarget | null = null;
  let range = '';
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (value === undefined || value === '') error(USAGE, ERROR_REASON.USAGE);
    if (flag === '--phase' || flag === '--plan') {
      // An option-shaped ID is a missing value: `--phase --plan …` must not select `--plan`.
      // Not applied to --range: `--phase` is a legal branch name, and --end-of-options
      // already makes any range safe to hand to git.
      if (target || value.startsWith('--')) error(USAGE, ERROR_REASON.USAGE);
      target = { mode: flag === '--phase' ? 'phase' : 'plan', id: value };
    } else if (flag === '--range') {
      range = value;
    } else {
      error(USAGE, ERROR_REASON.USAGE);
    }
  }
  if (!target || !range) error(USAGE, ERROR_REASON.USAGE);
  const commits = selectScopedCommits(cwd, target as ScopeTarget, range, deps);
  const write = deps?.write ?? ((s: string) => process.stdout.write(s));
  for (const c of commits) write(`${c.sha} ${c.subject}\n`);
  return commits;
}
