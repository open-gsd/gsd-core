/**
 * Keep a machine-local file out of `git status`: append an anchored entry to the
 * enclosing repo's `info/exclude` (#5551), and write its committed counterpart, a
 * `/<file>` line in the `.gitignore` beside it (#5505).
 *
 * Used for files GSD writes under `.planning/` that are per-machine state, not
 * project content (the milestone claim and the derived `state.json`, #5505).
 * `excludeFromGit` is the per-clone fallback and applies the one ownership gate for
 * every caller: a repo that merely encloses the project is left alone. An exclude
 * entry never untracks a copy that is already tracked; the state.json publisher
 * untracks it in `state-contract.cts` (idempotent, staged, file kept on disk).
 * `ignoreInTree` is the rule a new project commits from the start and the migration
 * writes for an existing one.
 *
 * Best-effort by contract: never throws. Ignoring is optional, so no failure
 * here (no git, read-only `.git`, odd path) may perturb the caller.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGit } from './shell-command-projection.cjs';
import { splitLines } from './text-lines.cjs';

// The one bound for the git calls on a boundary command's hot path (exclude, ownership probe, check-ignore,
// state.json migration): a hung git fails fast there instead of waiting out execGit's 10 s default.
export const GIT_PROBE_TIMEOUT_MS = 5_000;

/** Escape gitignore metacharacters so a directory or file name matches literally. */
function escapeGitignore(s: string): string {
  return s.replace(/[\\*?[]/g, '\\$&');
}

/** True when the repo that git-ignores via info/exclude owns the project: a `.git` entry between `dir` and the project root, else a tracked file under the project. */
function repoOwnsProject(projectRoot: string, dir: string): boolean {
  const root = path.resolve(projectRoot);
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    if (d === root || d === path.dirname(d)) break;
  }
  // One byte of output answers the question: git is killed at the first tracked path (ENOBUFS), so a large repo costs one path, not a listing.
  const r = execGit(['ls-files', '-z', '--', '.'], { cwd: root, timeout: GIT_PROBE_TIMEOUT_MS, maxBuffer: 1 });
  return (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS' || (r.exitCode === 0 && r.stdout.length > 0);
}

/**
 * Ask git who decides about `<dir>/<filename>` today. 'ignored': a rule already hides it.
 * 'negated': the last matching rule is a `!` pattern, the user chose to track it (any
 * spelling or glob, git reads them all). 'open': no rule speaks.
 */
function ignoreVerdict(dir: string, filename: string): 'ignored' | 'negated' | 'open' {
  const r = execGit(['check-ignore', '--no-index', '-v', '--', filename], { cwd: dir, timeout: GIT_PROBE_TIMEOUT_MS });
  // `-v` prints the deciding rule as `<source>:<line>:<pattern>\t<path>` and exits 0 for a `!` rule too.
  const rule = /:\d+:([^\t]*)\t/.exec(String(r.stdout));
  if (!rule) return 'open';
  return rule[1].startsWith('!') ? 'negated' : 'ignored';
}

/**
 * Exclude `<dir>/<filename>` from git via the repo-local `info/exclude`, for a project rooted at
 * `projectRoot`. `dir` must already exist (it is the spawn cwd). Returns true when the file is now
 * hidden by a rule (the entry was appended or a rule already hides it), false when nothing hides it
 * (the repo does not own the project, the user negated it, or a git call failed).
 */
export function excludeFromGit(projectRoot: string, dir: string, filename: string): boolean {
  try {
    // gitignore cannot express a newline in a pattern, and git's line output could not be split.
    if (/[\r\n]/.test(dir)) return false;
    if (!repoOwnsProject(projectRoot, dir)) return false;
    // The prefix goes last: stdout is trimmed, and a non-empty prefix ends in `/`, so only an
    // empty prefix (dir is the git root) loses its line; a leading space survives.
    const revParse = execGit(['rev-parse', '--git-path', 'info/exclude', '--show-prefix'], { cwd: dir, timeout: GIT_PROBE_TIMEOUT_MS });
    const [excludeRel, prefix = ''] = splitLines(String(revParse.stdout));
    if (revParse.exitCode !== 0 || !excludeRel) return false;
    // The target is whatever path git itself resolves for info/exclude (a linked worktree, core.hooksPath-style
    // layouts and GIT_DIR all move it); nothing here builds a `.git/...` path by hand.
    const exclude = path.resolve(dir, excludeRel);
    const entry = `/${escapeGitignore(prefix)}${escapeGitignore(filename)}`;
    // git decides first: our own entry reads as 'ignored', and a later `!` rule (in-tree or global) still wins over a stale entry.
    const verdict = ignoreVerdict(dir, filename);
    if (verdict !== 'open') return verdict === 'ignored';
    // linked worktrees share this file: two racing publishes may both append the entry, and git reads a duplicated line as one
    const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, (existing && !existing.endsWith('\n') ? '\n' : '') + entry + '\n');
    return true;
  } catch {
    // advisory: see the module header.
    return false;
  }
}

/** The anchored rule line `ignoreInTree` writes: the one builder, so a reader of the rule file (cmdCommit's migration carry) cannot drift from the writer. */
export function ignoreRuleLine(filename: string, subpath = ''): string {
  return `/${subpath}${escapeGitignore(filename)}`;
}

/**
 * Write the committed counterpart of `excludeFromGit`: an anchored `/<filename>` line in
 * `<dir>/.gitignore`, created or extended once (idempotent). `subpath` is a raw glob prefix below
 * `dir` (`workstreams/* /` without the space), for copies the file has in nested directories. A `!`
 * line the user wrote for the file is kept as their decision. Returns true when the rule is in place.
 */
export function ignoreInTree(dir: string, filename: string, subpath = ''): boolean {
  try {
    const file = path.join(dir, '.gitignore');
    const line = ignoreRuleLine(filename, subpath);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const present = splitLines(existing);
    if (present.includes(`!${line}`)) return false;
    if (present.includes(line)) return true;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, (existing && !existing.endsWith('\n') ? '\n' : '') + line + '\n');
    return true;
  } catch {
    return false;
  }
}
