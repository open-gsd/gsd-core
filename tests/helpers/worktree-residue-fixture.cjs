'use strict';

/**
 * Fixture helpers for the `reapOrphanWorktrees` residue tests (#4941).
 *
 * Two files test the residue sweep: `tests/worktree-safety-reap.test.cjs`
 * (fault-injected verdicts, Linux-only) and the real-OS rows in
 * `tests/worktree-safety.test.cjs`, which is in the Windows and macOS
 * conformance tiers. The real-OS rows live there so the reap file stays out of
 * the tiers (trek-e ruling 6673490034, ADR-4641's 33% ceiling). Both files
 * build the same fixtures, so the helpers live here once.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runGit } = require('./process-seam.cjs');
const { throwIfFailed } = require('./git-fixture.cjs');
const { cmdWorktreeReapOrphans } = require('../../gsd-core/bin/lib/worktree-safety.cjs');
const { execGit: seamExecGit } = require('../../gsd-core/bin/lib/shell-command-projection.cjs');

// #3145: deliberately double the GIT_TIMEOUT_MS class norm (see
// helpers/timeouts.cjs) — each residue test does real-git worktree/branch setup
// AND a `.git/worktrees/<name>/` admin-directory mutation AND one or more
// reapOrphanWorktrees invocations, more subprocess work per test than the
// plain fixture-setup case the norm is sized for.
const GIT_TIMEOUT_MS = 30000;

/** Older than any staleness threshold, at any real point in time. */
const STALE_MTIME = new Date(0);

function canonicalPath(p) {
  try { return fs.realpathSync.native(path.resolve(p)); } catch { return path.resolve(p); }
}

/**
 * Long-form os.tmpdir(). Windows CI reports 8.3 short names that git does not
 * echo back, so every fixture path is built from the resolved form.
 */
function resolvedTmpDir() {
  try { return fs.realpathSync.native(os.tmpdir()); } catch { return os.tmpdir(); }
}

/** Run git for FIXTURE SETUP; throws on anything but a clean exit. */
function git(args, cwd) {
  const r = runGit(args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  throwIfFailed(r, `git ${args.join(' ')}`);
  return r.stdout;
}

/**
 * An `execGit`-shaped delegate that runs REAL git through the production seam,
 * so `env` (the throwaway `GIT_INDEX_FILE`), `rawStdout` and stdout trimming
 * behave as they do without a fault. Used as `makeFaultyGit`'s `passthrough` so
 * a test can fault one argv and leave every other call intact.
 */
function realExecGit(args, opts = {}) {
  return seamExecGit(args, { ...opts, timeout: opts.timeout ?? GIT_TIMEOUT_MS });
}

/** A benign zero-exit result carrying `stdout`. */
function okResult(stdout) {
  return { exitCode: 0, stdout, stderr: '', signal: null, error: null, timedOut: false };
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  git(['add', '-A'], dir);
  git(['commit', '-m', 'initial commit'], dir);
  // Exit code deliberately unchecked: the rename fails harmlessly when the
  // repo was already initialised on `main`.
  runGit(['branch', '-m', 'master', 'main'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
}

/** Deps every "owner is dead, lock is stale" test shares. */
function deadOwnerDeps(extra = {}) {
  return { isPidAlive: () => false, mtimeSafe: () => STALE_MTIME, ctimeSafe: () => STALE_MTIME, entryMtimeSafe: () => STALE_MTIME, ...extra };
}

/** Assert exactly one result row, and return it. */
function onlyRow(result) {
  assert.strictEqual(result.length, 1, `expected exactly one result row, got ${JSON.stringify(result)}`);
  return result[0];
}

/** The issue's shape: a harness worktree whose .git file is gone. */
function makeResidue(repoDir, name) {
  const dir = path.join(repoDir, '.claude', 'worktrees', name);
  git(['worktree', 'add', '-b', `worktree-${name}`, dir, 'HEAD'], repoDir);
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg-a'), { recursive: true });
  fs.unlinkSync(path.join(dir, '.git')); // a linked worktree's .git is a FILE
  return dir;
}

function repoWithResidue(tmpBase, name, residueName = 'agent-a0000001') {
  const repoDir = path.join(tmpBase, `repo-${name}`);
  initRepo(repoDir);
  const residue = makeResidue(repoDir, residueName);
  git(['worktree', 'prune'], repoDir);
  return { repoDir, residue };
}

/**
 * Ignore `patterns` in the checkout's `.git/info/exclude`: the residue
 * content check (#4941 review) counts only untracked files git does not
 * ignore as work, so a fixture that must be removable ignores its extras.
 */
function excludeLocally(repoDir, ...patterns) {
  fs.appendFileSync(path.join(repoDir, '.git', 'info', 'exclude'), patterns.map((p) => `${p}\n`).join(''));
}

/** A plain directory under .claude/worktrees: no `.git`, never registered. */
function plainChild(repoDir, name) {
  const dir = path.join(repoDir, '.claude', 'worktrees', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x\n');
  return dir;
}

const rows = (results) => results.map((r) => [canonicalPath(r.path), r.status, r.reason]);

/** Real git, except that `show-ref --verify` answers `exists(ref)`. */
const branchExists = (exists) => (args, opts) => (args[0] === 'show-ref'
  ? { exitCode: exists(args[args.length - 1]) ? 0 : 1, stdout: '', stderr: '', timedOut: false }
  : realExecGit(args, opts));

// The characters formatDiagnosticToken must escape (src/io.cts): C0 controls
// (`newlineAllowed` exempts the line terminator stderr is written with), DEL
// and C1, zero-width and directional marks, bidi embeddings/overrides and
// isolates, the line/paragraph separators and the BOM.
const RAW_RANGES = [[0x7f, 0x9f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0x2028, 0x2029], [0xfeff, 0xfeff]];
const hasRawChar = (s, newlineAllowed = false) => [...s].some((ch) => {
  const n = ch.codePointAt(0);
  if (n <= 0x1f) return !(newlineAllowed && n === 0x0a);
  return RAW_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
});

const runCli = (repoDir, extra = {}) => {
  const out = [];
  const err = [];
  cmdWorktreeReapOrphans(repoDir, { write: (s) => out.push(s), writeErr: (s) => err.push(s), ...deadOwnerDeps(), ...extra });
  return { json: JSON.parse(out.join('')), err };
};

module.exports = {
  GIT_TIMEOUT_MS,
  STALE_MTIME,
  canonicalPath,
  resolvedTmpDir,
  git,
  realExecGit,
  okResult,
  initRepo,
  deadOwnerDeps,
  onlyRow,
  makeResidue,
  repoWithResidue,
  excludeLocally,
  plainChild,
  rows,
  branchExists,
  hasRawChar,
  runCli,
};
