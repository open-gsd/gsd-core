'use strict';

/**
 * `reapOrphanWorktrees` — fault-injected verdict coverage (#3057, wave 3).
 *
 * Seam: gsd-core/bin/lib/worktree-safety.cjs
 * Interface: reapOrphanWorktrees, cmdWorktreeReapOrphans, pruneOrphanedWorktrees
 *
 * WHY A SECOND FILE FOR THIS MODULE
 * `tests/worktree-safety.test.cjs` is ~6.4k lines and its `reapOrphanWorktrees`
 * suites live inside a folded block with their own local fixture helpers. The
 * negative-space work below needs a different fixture shape (an injected
 * `execGit` that delegates to real git, plus per-test mutation of the
 * `.git/worktrees/<name>/` admin directory), so it gets its own module-bucketed
 * file rather than a third set of helpers wedged into the folded block.
 *
 * WHAT THIS FILE PINS THAT NOTHING ELSE DID
 * Every pre-existing test drove the DEFAULT `execGit` against real git and
 * injected only `mtimeSafe` / `nowMs` / `isPidAlive`. `reapOrphanWorktrees`
 * accepts `execGit`, `readDirSafe` and `readFileSafe` in the same `deps` bag,
 * and nothing used them — so every fail-closed `return` inside the function was
 * unreachable from the suite. Each test here injects exactly the one fault that
 * selects one branch and asserts the SPECIFIC `{status, reason}` verdict that
 * branch produces, never merely that the call returned an array.
 *
 * Determinism: no wall clock is read (`mtimeSafe`/`nowMs` are injected), and no
 * live PID is probed (`isPidAlive` is injected), so the only real-world
 * dependency is git itself.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');
const { runGit } = require('./helpers/process-seam.cjs');
const { throwIfFailed } = require('./helpers/git-fixture.cjs');
const { makeFaultyGit, withFaultyFs } = require('./helpers/faulty-deps.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  reapOrphanWorktrees,
  cmdWorktreeReapOrphans,
  pruneOrphanedWorktrees,
} = require('../gsd-core/bin/lib/worktree-safety.cjs');

// ─── Fixed clock values (ADR-456 clock seam) ─────────────────────────────────

/** Older than any staleness threshold, at any real point in time. */
const STALE_MTIME = new Date(0);

/** The lock-owner PID written into every fixture; liveness is always injected. */
const LOCK_OWNER_PID = '4242';

// #3145: deliberately double the GIT_TIMEOUT_MS class norm (see
// helpers/timeouts.cjs) — each test here does real-git worktree/branch setup
// AND a `.git/worktrees/<name>/` admin-directory mutation AND one or more
// reapOrphanWorktrees invocations, more subprocess work per test than the
// plain fixture-setup case the norm is sized for.
const REAP_FIXTURE_GIT_TIMEOUT_MS = 30000;

// ─── Path + git helpers ──────────────────────────────────────────────────────

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
  const r = runGit(args, { cwd, timeoutMs: REAP_FIXTURE_GIT_TIMEOUT_MS });
  throwIfFailed(r, `git ${args.join(' ')}`);
  return r.stdout;
}

/**
 * An `execGit`-shaped delegate that runs REAL git. Used as `makeFaultyGit`'s
 * `passthrough` so a test can fault one argv and leave every other call intact.
 */
function realExecGit(args, opts = {}) {
  const r = runGit(args, { cwd: opts.cwd, timeoutMs: REAP_FIXTURE_GIT_TIMEOUT_MS });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout,
    stderr: r.stderr,
    signal: r.signal,
    error: r.code === null ? null : Object.assign(new Error(r.code), { code: r.code }),
    timedOut: r.timedOut,
  };
}

/** A benign zero-exit result carrying `stdout`. */
function okResult(stdout) {
  return { exitCode: 0, stdout, stderr: '', signal: null, error: null, timedOut: false };
}

function argvOf(faultyGit) {
  return faultyGit.calls.map((c) => c.args.join(' '));
}

function calledWith(faultyGit, prefix) {
  return faultyGit.calls.some((c) => prefix.every((token, i) => c.args[i] === token));
}

// ─── Fixture construction ────────────────────────────────────────────────────

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
  runGit(['branch', '-m', 'master', 'main'], { cwd: dir, timeoutMs: REAP_FIXTURE_GIT_TIMEOUT_MS });
}

/** Locate `.git/worktrees/<name>/` for a linked worktree. */
function adminDirFor(repoDir, wtDir) {
  const commonDir = path.resolve(repoDir, git(['rev-parse', '--git-common-dir'], repoDir).trim());
  const worktreesDir = path.join(commonDir, 'worktrees');
  const wanted = canonicalPath(wtDir);
  for (const entry of fs.readdirSync(worktreesDir)) {
    const gitdirFile = path.join(worktreesDir, entry, 'gitdir');
    if (!fs.existsSync(gitdirFile)) continue;
    const pointer = fs.readFileSync(gitdirFile, 'utf8').trim();
    const root = path.resolve(worktreesDir, entry, pointer).replace(/[/\\]\.git$/, '');
    if (canonicalPath(root) === wanted) return path.join(worktreesDir, entry);
  }
  throw new Error(`no .git/worktrees/<name> admin dir for ${wtDir}`);
}

/**
 * Build a repo with one linked, locked worktree whose branch is merged into
 * `main` unless `merge:false`. The lock owner is a fixed PID string; liveness is
 * always supplied through `deps.isPidAlive`, never probed against the OS.
 */
function makeFixture(tmpBase, name, options = {}) {
  const repoDir = path.join(tmpBase, `repo-${name}`);
  const wtDir = path.join(tmpBase, `wt-${name}`);
  const branch = `worktree-agent-${name}`;

  initRepo(repoDir);
  git(['worktree', 'add', wtDir, '-b', branch], repoDir);
  fs.writeFileSync(path.join(wtDir, 'work.txt'), 'content\n');
  git(['add', '-A'], wtDir);
  git(['commit', '-m', `work in ${name}`], wtDir);
  if (options.merge !== false) {
    git(['merge', branch, '--no-ff', '-m', `merge ${branch}`], repoDir);
  }

  const adminDir = adminDirFor(repoDir, wtDir);
  if (options.lock !== false) {
    fs.writeFileSync(path.join(adminDir, 'locked'), LOCK_OWNER_PID);
  }
  return { repoDir, wtDir, branch, adminDir };
}

/** Deps every "owner is dead, lock is stale" test shares. */
function deadOwnerDeps(extra = {}) {
  return { isPidAlive: () => false, mtimeSafe: () => STALE_MTIME, ...extra };
}

/** Assert exactly one result row, and return it. */
function onlyRow(result) {
  assert.strictEqual(result.length, 1, `expected exactly one result row, got ${JSON.stringify(result)}`);
  return result[0];
}

// ─── Suite: default-branch discovery — fail-closed verdicts ──────────────────

describe('#3057 reapOrphanWorktrees: default-branch discovery verdicts', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-3057-reap-disc-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  test('returns no rows and never reads the admin directory when git cannot resolve --git-dir', () => {
    const f = makeFixture(tmpBase, 'nogitdir');
    const probed = [];
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 128, when: ['rev-parse', '--git-dir'] }],
      passthrough: realExecGit,
    });

    const result = reapOrphanWorktrees(f.repoDir, deadOwnerDeps({
      execGit: faultyGit,
      readDirSafe: (dir) => { probed.push(dir); return fs.readdirSync(dir); },
    }));

    assert.deepStrictEqual(result, []);
    assert.deepStrictEqual(probed, [], 'admin directory must not be read once --git-dir failed');
    // the residue pass locates its root first (#4941), then the admin pass asks for --git-dir
    assert.deepStrictEqual(argvOf(faultyGit), ['rev-parse --show-toplevel', 'rev-parse --git-dir --git-common-dir', 'rev-parse --git-dir']);
    assert.ok(fs.existsSync(f.wtDir), 'the worktree must survive a fail-closed bail-out');
  });

  test('returns no rows when the worktrees admin directory cannot be listed', () => {
    const f = makeFixture(tmpBase, 'nodir');
    const probed = [];
    const faultyGit = makeFaultyGit({ passthrough: realExecGit });

    const result = reapOrphanWorktrees(f.repoDir, deadOwnerDeps({
      execGit: faultyGit,
      readDirSafe: (dir) => { probed.push(dir); return null; },
    }));

    assert.deepStrictEqual(result, []);
    assert.strictEqual(probed.length, 1, 'the admin directory must be probed exactly once');
    assert.strictEqual(path.basename(probed[0]), 'worktrees');
    // Distinguishes this bail-out from the --git-dir one above: --git-dir DID
    // run and succeed, and nothing after the admin listing was attempted.
    // the residue pass locates its root first (#4941), then the admin pass asks for --git-dir
    assert.deepStrictEqual(argvOf(faultyGit), ['rev-parse --show-toplevel', 'rev-parse --git-dir --git-common-dir', 'rev-parse --git-dir']);
  });

  test('returns no rows for a repo that has no linked worktrees at all', () => {
    // Exercises the real `defaultReadDirSafe` catch: `.git/worktrees/` does not
    // exist, so readdirSync throws and the helper returns null.
    const repoDir = path.join(tmpBase, 'repo-bare-of-worktrees');
    initRepo(repoDir);

    assert.deepStrictEqual(reapOrphanWorktrees(repoDir), []);
  });

  test('reaps from origin/HEAD alone and never consults local branch candidates', () => {
    const f = makeFixture(tmpBase, 'remotehead');
    const mainTip = git(['rev-parse', 'main'], f.repoDir).trim();
    const faultyGit = makeFaultyGit({
      passthrough: (args, opts) => {
        if (args[0] === 'symbolic-ref' && args[args.length - 1] === 'refs/remotes/origin/HEAD') {
          return okResult('origin/main\n');
        }
        if (args[0] === 'rev-parse' && args[1] === 'refs/remotes/origin/main') {
          return okResult(`${mainTip}\n`);
        }
        return realExecGit(args, opts);
      },
    });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(row.status, 'reaped');
    assert.strictEqual(row.reason, 'pid_dead_and_merged');
    // The remote-exclusive arm is what makes this distinguishable from the
    // local-candidate arm that every other fixture in the tree takes.
    assert.strictEqual(calledWith(faultyGit, ['remote']), false, 'must not fall back to remote enumeration');
    assert.strictEqual(
      calledWith(faultyGit, ['config', '--get', 'init.defaultBranch']),
      false,
      'must not build a local candidate list when origin/HEAD resolved'
    );
  });

  test('returns no rows when origin/HEAD names a remote ref that will not resolve', () => {
    const f = makeFixture(tmpBase, 'badremoteref');
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 128, when: ['rev-parse', 'refs/remotes/origin/main'] }],
      passthrough: (args, opts) => (
        args[0] === 'symbolic-ref' && args[args.length - 1] === 'refs/remotes/origin/HEAD'
          ? okResult('origin/main\n')
          : realExecGit(args, opts)
      ),
    });

    const result = reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit }));

    assert.deepStrictEqual(result, []);
    assert.strictEqual(
      calledWith(faultyGit, ['worktree', 'list']),
      false,
      'must fail closed before building the canonical index'
    );
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('returns no rows when a remote exists but origin/HEAD is unset', () => {
    const f = makeFixture(tmpBase, 'ambiguousremote');
    const originSrc = path.join(tmpBase, 'origin-src');
    initRepo(originSrc);
    git(['remote', 'add', 'origin', originSrc], f.repoDir);
    const faultyGit = makeFaultyGit({ passthrough: realExecGit });

    const result = reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit }));

    assert.deepStrictEqual(result, [], 'an ambiguous default branch must not be guessed');
    assert.strictEqual(calledWith(faultyGit, ['remote']), true);
    assert.strictEqual(
      calledWith(faultyGit, ['config', '--get', 'init.defaultBranch']),
      false,
      'the candidate list must not be built once a remote is known to exist'
    );
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('returns no rows when not one default-branch candidate resolves', () => {
    const f = makeFixture(tmpBase, 'nocandidate');
    const faultyGit = makeFaultyGit({
      faults: [{
        kind: 'exit',
        exitCode: 128,
        when: (args) => args[0] === 'rev-parse' && args[1] !== '--git-dir',
      }],
      passthrough: realExecGit,
    });

    const result = reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit }));

    assert.deepStrictEqual(result, []);
    assert.strictEqual(calledWith(faultyGit, ['rev-parse', 'main']), true);
    assert.strictEqual(calledWith(faultyGit, ['rev-parse', 'master']), true);
    assert.strictEqual(
      calledWith(faultyGit, ['worktree', 'list']),
      false,
      'must fail closed before building the canonical index'
    );
  });
});

// ─── Suite: canonical-index construction ─────────────────────────────────────

describe('#3057 reapOrphanWorktrees: canonical-index degradation verdicts', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-3057-reap-idx-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  test('still reaps when git worktree list fails and the canonical index stays empty', () => {
    const f = makeFixture(tmpBase, 'listfails');
    const wtCanonical = canonicalPath(f.wtDir);
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'timeout', when: ['worktree', 'list'] }],
      passthrough: realExecGit,
    });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    // A failed listing must degrade to the gitdir-derived path, NOT abort the
    // sweep — an empty index is not "there is nothing to reap".
    assert.strictEqual(row.status, 'reaped');
    assert.strictEqual(row.reason, 'pid_dead_and_merged');
    assert.strictEqual(canonicalPath(row.path), wtCanonical);
    assert.strictEqual(calledWith(faultyGit, ['worktree', 'list']), true);
    assert.strictEqual(fs.existsSync(f.wtDir), false);
  });

  test('still reaps when a porcelain block carries no worktree line', () => {
    const f = makeFixture(tmpBase, 'headlessblock');
    const realPorcelain = git(['worktree', 'list', '--porcelain'], f.repoDir);
    const faultyGit = makeFaultyGit({
      passthrough: (args, opts) => (
        args[0] === 'worktree' && args[1] === 'list'
          ? okResult(`bare\n\n${realPorcelain}`)
          : realExecGit(args, opts)
      ),
    });

    // Without the `continue`, `wtLine.slice(...)` would throw on the leading
    // block and the whole sweep would die.
    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(row.status, 'reaped');
    assert.strictEqual(row.reason, 'pid_dead_and_merged');
  });

  test('still reaps when the porcelain lists a path that no longer exists on disk', () => {
    const f = makeFixture(tmpBase, 'ghostpath');
    const realPorcelain = git(['worktree', 'list', '--porcelain'], f.repoDir);
    const ghost = path.join(tmpBase, 'ghost-worktree');
    const faultyGit = makeFaultyGit({
      passthrough: (args, opts) => (
        args[0] === 'worktree' && args[1] === 'list'
          ? okResult(`worktree ${ghost}\nHEAD 0000000000000000000000000000000000000000\n\n${realPorcelain}`)
          : realExecGit(args, opts)
      ),
    });

    // realpathSync.native throws for the ghost block; the catch must skip that
    // one entry and keep indexing the rest.
    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(row.status, 'reaped');
    assert.strictEqual(row.reason, 'pid_dead_and_merged');
  });
});

// ─── Suite: admin-directory shape ────────────────────────────────────────────

describe('#3057 reapOrphanWorktrees: admin-entry verdicts', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-3057-reap-admin-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  test('reports no row at all for a linked worktree that carries no lock file', () => {
    const f = makeFixture(tmpBase, 'locked');
    const unlockedDir = path.join(tmpBase, 'wt-unlocked');
    git(['worktree', 'add', unlockedDir, '-b', 'worktree-agent-unlocked'], f.repoDir);

    const result = reapOrphanWorktrees(f.repoDir, deadOwnerDeps());

    const row = onlyRow(result);
    assert.strictEqual(canonicalPath(row.path), canonicalPath(f.wtDir));
    assert.strictEqual(row.status, 'reaped');
    assert.ok(fs.existsSync(unlockedDir), 'an unlocked worktree is not the reaper concern');
  });

  test('reports no row for a locked admin entry whose gitdir pointer is missing', () => {
    const f = makeFixture(tmpBase, 'nopointer');
    fs.unlinkSync(path.join(f.adminDir, 'gitdir'));

    // The lock file is present and stale and the owner is dead, so a row WOULD
    // be emitted if the missing pointer were not a hard skip.
    assert.deepStrictEqual(reapOrphanWorktrees(f.repoDir, deadOwnerDeps()), []);
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports no row when an injected readFileSafe reports the gitdir pointer as empty', () => {
    const f = makeFixture(tmpBase, 'blankpointer');
    const gitdirFile = path.join(f.adminDir, 'gitdir');

    // Covers the `deps.readFileSafe` seam arm AND the empty-string half of the
    // falsy-pointer guard (the missing-file half returns null, not '').
    const result = reapOrphanWorktrees(f.repoDir, deadOwnerDeps({
      readFileSafe: (file) => {
        if (path.resolve(file) === path.resolve(gitdirFile)) return '';
        try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
      },
    }));

    assert.deepStrictEqual(result, []);
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports lock_age_unknown when the real mtime helper cannot stat the lock file', () => {
    const f = makeFixture(tmpBase, 'statfails');

    // No `mtimeSafe` injection: this drives the module's own default helper and
    // pins its catch arm. nowMs is the far future, so a readable mtime would
    // read as stale and reap.
    const result = withFaultyFs(
      { statSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } },
      () => reapOrphanWorktrees(f.repoDir, { isPidAlive: () => false, nowMs: 8640000000000000 })
    );

    const row = onlyRow(result);
    // NOT `lock_too_fresh` (#3057): an unreadable mtime is not an age at all.
    // Freshness tells an operator to wait; waiting never clears an EIO.
    assert.deepStrictEqual(
      { status: row.status, reason: row.reason },
      { status: 'skipped', reason: 'lock_age_unknown' }
    );
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports remove_failed against the raw gitdir pointer when its basename is not .git', () => {
    const f = makeFixture(tmpBase, 'oddpointer');
    const pointerTarget = path.join(f.wtDir, 'notgit');
    fs.writeFileSync(path.join(f.adminDir, 'gitdir'), `${pointerTarget}\n`);
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 1, when: ['worktree', 'remove'] }],
      passthrough: realExecGit,
    });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    // `path` is the load-bearing assertion: a pointer that does not end in
    // `/.git` is used verbatim (no dirname()), and because it does not exist,
    // the canonical lookup throws and the raw path is what reaches git.
    assert.strictEqual(row.path, pointerTarget);
    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'remove_failed');
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports lock_age_unknown, not lock_too_fresh, when mtimeSafe returns null', () => {
    const f = makeFixture(tmpBase, 'nomtime');

    // nowMs is the far future, so a REAL mtime would read as stale and the
    // entry would be reaped. Only the null-mtime arm can produce this verdict.
    const row = onlyRow(reapOrphanWorktrees(f.repoDir, {
      isPidAlive: () => false,
      mtimeSafe: () => null,
      nowMs: 8640000000000000,
    }));

    assert.deepStrictEqual(
      { status: row.status, reason: row.reason },
      { status: 'skipped', reason: 'lock_age_unknown' }
    );
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports lock_too_fresh, not lock_age_unknown, for a readable zero-age lock under the default guard', () => {
    const f = makeFixture(tmpBase, 'defaultguard');
    const now = 1000000;

    // The other half of the split: the mtime IS readable, the lock genuinely is
    // recent, and waiting out the guard genuinely would change the outcome.
    const row = onlyRow(reapOrphanWorktrees(f.repoDir, {
      isPidAlive: () => false,
      mtimeSafe: () => new Date(now),
      nowMs: now,
    }));

    assert.deepStrictEqual(
      { status: row.status, reason: row.reason },
      { status: 'skipped', reason: 'lock_too_fresh' }
    );
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reaps the same zero-age lock when an injected reapMtimeGuardMs of 0 retires the guard', () => {
    const f = makeFixture(tmpBase, 'zeroguard');
    const now = 1000000;

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, {
      isPidAlive: () => false,
      mtimeSafe: () => new Date(now),
      nowMs: now,
      reapMtimeGuardMs: 0,
    }));

    assert.strictEqual(row.status, 'reaped');
    assert.strictEqual(row.reason, 'pid_dead_and_merged');
  });
});

// ─── Suite: liveness and ancestry verdicts ───────────────────────────────────

describe('#3057 reapOrphanWorktrees: liveness and ancestry verdicts', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-3057-reap-live-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  test('reports pid_alive when the lock owner is alive', () => {
    const f = makeFixture(tmpBase, 'alive');

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, {
      isPidAlive: () => true,
      mtimeSafe: () => STALE_MTIME,
    }));

    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'pid_alive');
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports pid_alive when the liveness probe throws', () => {
    const f = makeFixture(tmpBase, 'probethrows');

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, {
      isPidAlive: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
      mtimeSafe: () => STALE_MTIME,
    }));

    // An undeterminable owner is treated as alive — same verdict as a genuinely
    // live owner, which is the intended fail-closed conflation.
    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'pid_alive');
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports pid_alive from the default isPidAlive helper when process.kill throws EPERM', (t) => {
    // No `isPidAlive` injection: this drives the module's OWN default helper
    // (`defaultIsPidAlive`), whose EPERM arm every other test in this tree
    // bypasses by injecting `isPidAlive` directly. `process.kill` is
    // monkeypatched per CONTRIBUTING's cross-platform IO-fault-injection rule
    // rather than run against a real cross-user PID.
    const f = makeFixture(tmpBase, 'defaultkill-eperm');
    const originalKill = process.kill;
    t.after(() => { process.kill = originalKill; });
    process.kill = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, { mtimeSafe: () => STALE_MTIME }));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'pid_alive' });
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports pid_dead_and_merged from the default isPidAlive helper when process.kill throws ESRCH', (t) => {
    // Same default helper as above, but its dead-owner arm: ESRCH means "no
    // such process", so `defaultIsPidAlive` returns false and the sweep falls
    // through to the (merged, by fixture default) ancestry check and reaps.
    const f = makeFixture(tmpBase, 'defaultkill-esrch');
    const originalKill = process.kill;
    t.after(() => { process.kill = originalKill; });
    process.kill = () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); };

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, { mtimeSafe: () => STALE_MTIME }));

    assert.deepStrictEqual(
      { status: row.status, reason: row.reason },
      { status: 'reaped', reason: 'pid_dead_and_merged' }
    );
    assert.strictEqual(fs.existsSync(f.wtDir), false);
  });

  test('reports pid_alive from the default isPidAlive helper when process.kill returns without throwing', (t) => {
    // The non-throwing arm of `defaultIsPidAlive`: a live owner's `kill(pid,
    // 0)` returns normally, so the helper returns true directly, with no
    // catch block involved at all.
    const f = makeFixture(tmpBase, 'defaultkill-alive');
    const originalKill = process.kill;
    t.after(() => { process.kill = originalKill; });
    process.kill = () => true;

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, { mtimeSafe: () => STALE_MTIME }));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'pid_alive' });
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports cannot_resolve_branch_tip when the admin HEAD file is absent', () => {
    const f = makeFixture(tmpBase, 'noheadfile');
    fs.unlinkSync(path.join(f.adminDir, 'HEAD'));
    const faultyGit = makeFaultyGit({ passthrough: realExecGit });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'cannot_resolve_branch_tip');
    assert.strictEqual(
      calledWith(faultyGit, ['merge-base']),
      false,
      'ancestry must not be probed once the tip is unknown'
    );
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reports cannot_resolve_branch_tip when the admin HEAD names an unresolvable branch', () => {
    const f = makeFixture(tmpBase, 'deadsymref');
    fs.writeFileSync(path.join(f.adminDir, 'HEAD'), 'ref: refs/heads/does-not-exist\n');
    const faultyGit = makeFaultyGit({ passthrough: realExecGit });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'cannot_resolve_branch_tip');
    // Distinguishes the symbolic-ref arm from the missing-file and
    // unrecognised-content arms, which all share this one reason string.
    assert.strictEqual(calledWith(faultyGit, ['rev-parse', 'refs/heads/does-not-exist']), true);
  });

  test('reports cannot_resolve_branch_tip for an admin HEAD that is neither a symref nor a sha', () => {
    const f = makeFixture(tmpBase, 'garbagehead');
    const headFile = path.join(f.adminDir, 'HEAD');
    fs.writeFileSync(headFile, 'not-a-ref\n');
    const faultyGit = makeFaultyGit({ passthrough: realExecGit });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'cannot_resolve_branch_tip');
    assert.ok(fs.existsSync(headFile), 'the HEAD file is present — this is not the missing-file arm');
    assert.strictEqual(
      faultyGit.calls.some((c) => c.args[0] === 'rev-parse' && String(c.args[1]).startsWith('refs/heads/')),
      false,
      'unrecognised HEAD content must not be handed to rev-parse'
    );
  });

  test('reaps a detached admin HEAD without resolving any branch ref', () => {
    const f = makeFixture(tmpBase, 'detached');
    const branchTip = git(['rev-parse', f.branch], f.repoDir).trim();
    fs.writeFileSync(path.join(f.adminDir, 'HEAD'), `${branchTip}\n`);
    const faultyGit = makeFaultyGit({ passthrough: realExecGit });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(row.status, 'reaped');
    assert.strictEqual(row.reason, 'pid_dead_and_merged');
    assert.strictEqual(
      faultyGit.calls.some((c) => c.args[0] === 'rev-parse' && String(c.args[1]).startsWith('refs/heads/')),
      false,
      'a bare 40-hex HEAD is the tip; no ref resolution is needed'
    );
    assert.strictEqual(fs.existsSync(f.wtDir), false);
  });

  test('reports branch_not_merged for an unmerged branch whose lock owner is dead', () => {
    const f = makeFixture(tmpBase, 'unmerged', { merge: false });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps()));

    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'branch_not_merged');
    assert.ok(fs.existsSync(f.wtDir), 'unmerged work must survive the sweep');
  });

  // ── The Number.isFinite PARSE gate ────────────────────────────────────────
  // This gate is NOT the process.kill range limit (pinned in the next block).
  // It fires far later, where `parseInt('9'.repeat(N), 10)` stops being
  // representable: finite through N=308, Infinity from N=309 (measured).
  // Reaching it means the reaper never learned a usable PID at all, so the
  // verdict is `lock_owner_unknown`, not a liveness claim.

  test('reports lock_owner_unknown for a 400-digit lock PID (parse overflows past the Number.isFinite gate)', () => {
    const f = makeFixture(tmpBase, 'giantpid', { lock: false });
    fs.writeFileSync(path.join(f.adminDir, 'locked'), '9'.repeat(400));

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps()));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'lock_owner_unknown' });
    assert.ok(fs.existsSync(f.wtDir), 'a lock PID that overflows to Infinity must never be reaped');
  });

  test('passes a 308-digit lock PID through the Number.isFinite gate (last representable length)', () => {
    const f = makeFixture(tmpBase, 'cliffminus1', { lock: false });
    fs.writeFileSync(path.join(f.adminDir, 'locked'), '9'.repeat(308));
    let seenPid;

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({
      isPidAlive: (pid) => { seenPid = pid; return false; },
    })));

    assert.strictEqual(seenPid, Number('9'.repeat(308)), 'a finite 308-digit PID must reach isPidAlive unchanged');
    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'reaped', reason: 'pid_dead_and_merged' });
    assert.strictEqual(fs.existsSync(f.wtDir), false);
  });

  test('stops a 309-digit lock PID at the Number.isFinite gate (first unrepresentable length)', () => {
    const f = makeFixture(tmpBase, 'cliffexact', { lock: false });
    fs.writeFileSync(path.join(f.adminDir, 'locked'), '9'.repeat(309));

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps()));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'lock_owner_unknown' });
    assert.ok(fs.existsSync(f.wtDir));
  });

  // ── The process.kill RANGE cliff — the one that actually decides a reap ───
  // Measured with the real `process.kill(pid, 0)` on this platform:
  //   2147483647 → Error, code ESRCH          (accepted; asks the OS)
  //   2147483648 → TypeError ERR_INVALID_ARG_TYPE (rejected before the OS)
  // Both tests drive the module's OWN `defaultIsPidAlive` (no `isPidAlive`
  // injection) so the verdict is produced by the real errno classification.
  // Each asserts the throw shape first: if a future Node moved the cliff, the
  // probe fails loudly instead of the verdict flipping silently.

  const PID_KILL_MAX = 2147483647;

  test('treats the largest PID process.kill accepts as dead when the OS answers ESRCH', () => {
    const f = makeFixture(tmpBase, 'killmax', { lock: false });
    fs.writeFileSync(path.join(f.adminDir, 'locked'), String(PID_KILL_MAX));

    // Measured cliff, lower side: this value reaches the OS, which has no such
    // process (every platform's max PID is orders of magnitude below it).
    assert.throws(
      () => process.kill(PID_KILL_MAX, 0),
      (err) => err.code === 'ESRCH',
      `process.kill(${PID_KILL_MAX}, 0) must reach the OS and report ESRCH`
    );

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, { mtimeSafe: () => STALE_MTIME }));

    assert.deepStrictEqual(
      { status: row.status, reason: row.reason },
      { status: 'reaped', reason: 'pid_dead_and_merged' }
    );
    assert.strictEqual(fs.existsSync(f.wtDir), false);
  });

  test('treats the first PID process.kill rejects as ALIVE and leaves the worktree on disk', () => {
    const f = makeFixture(tmpBase, 'killmaxplus1', { lock: false });
    const overRange = PID_KILL_MAX + 1;
    fs.writeFileSync(path.join(f.adminDir, 'locked'), String(overRange));

    // Measured cliff, upper side: one past the accepted range, `process.kill`
    // throws a TypeError with NO errno. That is "could not determine", not
    // "dead" — the old errno-only catch read it as dead and REAPED here.
    assert.throws(
      () => process.kill(overRange, 0),
      (err) => err instanceof TypeError && err.code === 'ERR_INVALID_ARG_TYPE',
      `process.kill(${overRange}, 0) must throw TypeError ERR_INVALID_ARG_TYPE`
    );

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, { mtimeSafe: () => STALE_MTIME }));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'pid_alive' });
    assert.ok(fs.existsSync(f.wtDir), 'an unclassifiable liveness probe must never reap');
  });

  test('treats an unrecognised errno from process.kill as ALIVE (only ESRCH means dead)', (t) => {
    // EPERM has its own test above; this pins the GENERAL rule for a code the
    // helper has never heard of, which an `=== EPERM ? true : false` catch
    // would classify as dead.
    const f = makeFixture(tmpBase, 'defaultkill-einval');
    const originalKill = process.kill;
    t.after(() => { process.kill = originalKill; });
    process.kill = () => { throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' }); };

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, { mtimeSafe: () => STALE_MTIME }));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'pid_alive' });
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('treats a codeless throw from process.kill as ALIVE', (t) => {
    // A thrown value with no `.code` at all (the TypeError case in the
    // abstract): `undefined !== 'ESRCH'`, so it must still read as alive.
    const f = makeFixture(tmpBase, 'defaultkill-bare');
    const originalKill = process.kill;
    t.after(() => { process.kill = originalKill; });
    process.kill = () => { throw new Error('no errno on this one'); };

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, { mtimeSafe: () => STALE_MTIME }));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'pid_alive' });
    assert.ok(fs.existsSync(f.wtDir));
  });

  test('reaches the liveness check for an ordinary small lock PID', () => {
    const f = makeFixture(tmpBase, 'ordinarypid', { lock: false });
    fs.writeFileSync(path.join(f.adminDir, 'locked'), '4242');
    let seenPid;

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({
      isPidAlive: (pid) => { seenPid = pid; return false; },
    })));

    assert.strictEqual(seenPid, 4242, 'an ordinary PID must reach isPidAlive unchanged');
    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'reaped', reason: 'pid_dead_and_merged' });
    assert.strictEqual(fs.existsSync(f.wtDir), false);
  });

  test('reports remove_failed and leaves the worktree on disk when git worktree remove fails', () => {
    const f = makeFixture(tmpBase, 'removefails');
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 1, when: ['worktree', 'remove'] }],
      passthrough: realExecGit,
    });

    const row = onlyRow(reapOrphanWorktrees(f.repoDir, deadOwnerDeps({ execGit: faultyGit })));

    assert.strictEqual(canonicalPath(row.path), canonicalPath(f.wtDir));
    assert.strictEqual(row.status, 'skipped');
    assert.strictEqual(row.reason, 'remove_failed');
    assert.ok(fs.existsSync(f.wtDir));
    assert.strictEqual(calledWith(faultyGit, ['worktree', 'unlock']), true, 'unlock precedes remove');
  });
});

// ─── Suite: CLI wrappers ─────────────────────────────────────────────────────

describe('#3057 cmdWorktreeReapOrphans / pruneOrphanedWorktrees output verdicts', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-3057-reap-cli-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  test('cmdWorktreeReapOrphans reports ok with zero entries after the reaper throws', () => {
    const out = [];
    const err = [];

    cmdWorktreeReapOrphans(tmpBase, {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      execGit: () => { throw new Error('boom'); },
    });

    assert.deepStrictEqual(err, ['[gsd] worktree.reap-orphans failed: boom\n']);
    assert.deepStrictEqual(JSON.parse(out.join('')), { ok: true, reaped: 0, entries: [], scan: null });
  });

  test('cmdWorktreeReapOrphans warns with the skipped count and emits the skipped row as JSON', () => {
    const f = makeFixture(tmpBase, 'cliskip', { merge: false });
    const out = [];
    const err = [];

    cmdWorktreeReapOrphans(f.repoDir, {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      ...deadOwnerDeps(),
    });

    assert.deepStrictEqual(err, [
      '[gsd] worktree.reap-orphans: 1 orphan(s) skipped (run with DEBUG=1 for details)\n',
    ]);
    const payload = JSON.parse(out.join(''));
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.reaped, 0);
    assert.strictEqual(payload.entries.length, 1);
    assert.strictEqual(payload.entries[0].status, 'skipped');
    assert.strictEqual(payload.entries[0].reason, 'branch_not_merged');
  });

  test('cmdWorktreeReapOrphans stays silent on stderr when nothing is skipped', () => {
    const f = makeFixture(tmpBase, 'cliclean');
    const out = [];
    const err = [];

    cmdWorktreeReapOrphans(f.repoDir, {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      ...deadOwnerDeps(),
    });

    assert.deepStrictEqual(err, []);
    const payload = JSON.parse(out.join(''));
    assert.strictEqual(payload.reaped, 1);
    assert.strictEqual(payload.entries[0].reason, 'pid_dead_and_merged');
  });

  test('pruneOrphanedWorktrees warns that the health check degraded when git worktree prune times out', () => {
    const f = makeFixture(tmpBase, 'prunetimeout');
    const err = [];
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'timeout', when: ['worktree', 'prune'] }],
      passthrough: realExecGit,
    });

    const removed = pruneOrphanedWorktrees(f.repoDir, {
      execGit: faultyGit,
      writeErr: (s) => err.push(s),
    });

    assert.deepStrictEqual(removed, []);
    assert.deepStrictEqual(err, [
      '[gsd-tools] WARNING: worktree health check degraded' +
      ' — git worktree prune timed out after 10s.' +
      ' Orphaned worktree metadata may remain until the next successful run.\n',
    ]);
  });

  test('pruneOrphanedWorktrees hands the porcelain to a caller-supplied parseWorktreePorcelain', () => {
    const f = makeFixture(tmpBase, 'pruneparser');
    const realPorcelain = git(['worktree', 'list', '--porcelain'], f.repoDir);
    const seen = [];
    const faultyGit = makeFaultyGit({ passthrough: realExecGit });

    // `parseWorktreePorcelain` is a declared member of the deps bag and
    // `planWorktreePrune` reads `deps.parseWorktreePorcelain` first, defaulting
    // to the module function only when absent. pruneOrphanedWorktrees therefore
    // spreads `...deps` AFTER its own hard-coded default so the caller's parser
    // wins. Ordering the two the other way round is invisible to every other
    // test in the tree; this one fails if the spread moves.
    const removed = pruneOrphanedWorktrees(f.repoDir, {
      execGit: faultyGit,
      parseWorktreePorcelain: (porcelain) => { seen.push(porcelain); return []; },
      writeErr: () => { throw new Error('no degradation warning expected'); },
    });

    assert.deepStrictEqual(removed, []);
    assert.strictEqual(seen.length, 1, 'the injected parser must be the one that ran, exactly once');
    assert.strictEqual(seen[0], realPorcelain, 'it must receive the porcelain readWorktreeList obtained');
    assert.strictEqual(calledWith(faultyGit, ['worktree', 'prune']), true, 'the metadata prune still runs');
  });

  test('pruneOrphanedWorktrees returns an empty list and warns nothing when git throws', () => {
    const f = makeFixture(tmpBase, 'prunethrows');
    const err = [];

    const removed = pruneOrphanedWorktrees(f.repoDir, {
      execGit: () => { throw new Error('boom'); },
      writeErr: (s) => err.push(s),
    });

    assert.deepStrictEqual(removed, [], 'a throwing git must never crash the caller');
    assert.deepStrictEqual(err, [], 'the degraded-health warning belongs to the timeout arm only');
  });
});

// ─── ADR-5812 / #4941: removal of unregistered residue under .claude/worktrees ────────────────────────────────

describe('ADR-5812 reapOrphanWorktrees: the .claude/worktrees residue pass', () => {
  /** A fixed instant far after any fixture timestamp: the race guard reads it, never the wall clock. */
  const FAR_FUTURE_MS = Date.UTC(2100, 0, 1);
  const GUARD_MS = 5 * 60 * 1000;
  const NAME = 'agent-a1b2c3d4e5f6';
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-5812-residue-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  function adrRepo(base = tmpBase) {
    const dir = path.join(base, 'repo');
    initRepo(dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env*\n.secrets/\n.planning/\n');
    git(['add', '-A'], dir);
    git(['commit', '-m', 'ignore rules'], dir);
    return dir;
  }

  const rootOf = (repo) => path.join(repo, '.claude', 'worktrees');

  /**
   * A harness worktree whose git bookkeeping is then forgotten: the `.git` file is deleted and (unless `prune:false`)
   * the admin entry is pruned. It holds an ignored node_modules, as the real residue does.
   */
  function residueDir(repo, { name = NAME, branch = `worktree-${name}`, prune = true } = {}) {
    const wt = path.join(rootOf(repo), name);
    fs.mkdirSync(rootOf(repo), { recursive: true });
    if (branch === null) git(['worktree', 'add', '--detach', wt], repo);
    else git(['worktree', 'add', wt, '-b', branch], repo);
    fs.mkdirSync(path.join(wt, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    cleanup(path.join(wt, '.git'));
    if (prune) git(['worktree', 'prune'], repo);
    return wt;
  }

  const rows = (repo, deps = {}) => reapOrphanWorktrees(repo, { nowMs: FAR_FUTURE_MS, ...deps }).map((r) => [path.basename(r.path), r.status, r.reason]);

  function verb(repo, deps = {}) {
    const out = [];
    const err = [];
    cmdWorktreeReapOrphans(repo, { nowMs: FAR_FUTURE_MS, write: (s) => out.push(s), writeErr: (s) => err.push(s), ...deps });
    return { json: JSON.parse(out.join('')), stderr: err.join('') };
  }

  describe('D1 location, shape, registration and identity', () => {
    test('[regression] a forgotten harness directory is reaped, its top-level contents are named, and the node_modules goes with it', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);

      const { json } = verb(repo);

      assert.strictEqual(json.reaped, 1);
      assert.deepStrictEqual(json.entries.map((e) => [path.basename(e.path), e.status, e.reason]), [[NAME, 'reaped', 'unregistered_residue']]);
      assert.deepStrictEqual(json.entries[0].contents, ['.gitignore', 'README.md', 'node_modules']);
      assert.ok(!fs.existsSync(wt));
    });

    test('[boundary] the verb says which sources it read: an absent admin directory is "absent", not "did not look"', () => {
      const repo = adrRepo();
      residueDir(repo);
      assert.deepStrictEqual(verb(repo).json.scan, { admin_dir: 'absent', residue_dir: 'scanned' });
      assert.deepStrictEqual(verb(adrRepoWith('absent')).json.scan, { admin_dir: 'absent', residue_dir: 'absent' });
    });

    function adrRepoWith() {
      const dir = path.join(tmpBase, 'repo-plain');
      initRepo(dir);
      return dir;
    }

    test('[security] a registered worktree is never residue, even with its .git file deleted and no prune (the prunable case)', () => {
      const repo = adrRepo();
      const wt = residueDir(repo, { prune: false });
      fs.writeFileSync(path.join(wt, 'precious.txt'), 'uncommitted\n');

      assert.deepStrictEqual(rows(repo), []);
      assert.ok(fs.existsSync(path.join(wt, 'precious.txt')));
    });

    test('[independence] a live worktree, a directory with a .git entry, an empty directory, a file and a link are not candidates', () => {
      const repo = adrRepo();
      fs.mkdirSync(rootOf(repo), { recursive: true });
      git(['worktree', 'add', path.join(rootOf(repo), 'agent-a0000000live'), '-b', 'worktree-agent-a0000000live'], repo);
      fs.mkdirSync(path.join(rootOf(repo), 'agent-a0000000gitf'));
      fs.writeFileSync(path.join(rootOf(repo), 'agent-a0000000gitf', '.git'), 'gitdir: /elsewhere\n');
      fs.mkdirSync(path.join(rootOf(repo), 'agent-a0000000empt'));
      fs.writeFileSync(path.join(rootOf(repo), 'agent-a0000000file'), 'not a directory\n');
      const outside = path.join(tmpBase, 'outside');
      fs.mkdirSync(outside);
      try { fs.symlinkSync(outside, path.join(rootOf(repo), 'agent-a0000000link'), 'dir'); } catch { /* no symlinks here */ }

      assert.deepStrictEqual(rows(repo), []);
    });

    test('[boundary] the name must be agent-a followed by at least seven hex digits, and a harness branch must exist', () => {
      const repo = adrRepo();
      residueDir(repo, { name: 'agent-a123456' });                       // six digits: too short
      residueDir(repo, { name: 'agent-b1234567' });                      // wrong letter
      residueDir(repo, { name: 'agent-a1234567', branch: 'unrelated' }); // seven digits, no harness branch
      residueDir(repo, { name: 'agent-a7654321', branch: 'agent-a7654321' }); // the other accepted branch spelling
      residueDir(repo, { name: 'agent-a1234567x', branch: 'worktree-agent-a1234567x' }); // trailing non-hex

      assert.deepStrictEqual(rows(repo).sort(), [
        ['agent-a123456', 'skipped', 'residue_not_harness_named'],
        ['agent-a1234567', 'skipped', 'residue_no_harness_branch'],
        ['agent-a1234567x', 'skipped', 'residue_not_harness_named'],
        ['agent-a7654321', 'reaped', 'unregistered_residue'],
        ['agent-b1234567', 'skipped', 'residue_not_harness_named'],
      ]);
    });

    test('[security] .claude or .claude/worktrees as a link is aliased: nothing is read or removed through it', (t) => {
      const repo = adrRepo();
      const victim = path.join(tmpBase, 'victim');
      fs.mkdirSync(path.join(victim, NAME), { recursive: true });
      fs.writeFileSync(path.join(victim, NAME, 'keep.txt'), 'must survive\n');
      fs.mkdirSync(path.join(repo, '.claude'));
      try { fs.symlinkSync(victim, rootOf(repo), 'dir'); } catch { t.skip('cannot create symlinks on this host'); return; }

      assert.strictEqual(verb(repo).json.scan.residue_dir, 'aliased');
      cleanup(rootOf(repo));
      cleanup(path.join(repo, '.claude'));
      fs.symlinkSync(path.join(victim, '..'), path.join(repo, '.claude'), 'dir');
      assert.strictEqual(verb(repo).json.scan.residue_dir, 'aliased');
      assert.strictEqual(fs.readFileSync(path.join(victim, NAME, 'keep.txt'), 'utf8'), 'must survive\n');
    });

    test('[independence] run from a linked worktree the sweep does not look, and says so', () => {
      const repo = adrRepo();
      const wt = residueDir(repo, { name: 'agent-a0000000aaaa' });
      const linked = path.join(tmpBase, 'linked');
      git(['worktree', 'add', linked, '-b', 'other'], repo);

      assert.strictEqual(verb(linked).json.scan.residue_dir, 'not_main_checkout');
      assert.ok(fs.existsSync(wt));
    });

    test('[boundary] a git directory that does not lead back to the top (core.worktree), unresolvable top, and unreadable root are reported, not swept', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      const faulty = makeFaultyGit({ faults: [{ kind: 'exit', exitCode: 128, when: ['rev-parse', '--show-toplevel'] }], passthrough: realExecGit });
      assert.strictEqual(verb(repo, { execGit: faulty }).json.scan.residue_dir, 'top_unresolved');
      const unreadableRoot = (d) => {
        if (d === rootOf(repo)) return null;
        try { return fs.readdirSync(d); } catch { return null; }
      };
      assert.strictEqual(verb(repo, { readDirSafe: unreadableRoot }).json.scan.residue_dir, 'unreadable');
      git(['config', 'core.worktree', path.join(tmpBase)], repo);
      assert.strictEqual(verb(repo).json.scan.residue_dir, 'git_mismatch');
      git(['config', '--unset', 'core.worktree'], repo);
      assert.ok(fs.existsSync(wt));
    });

    test('[boundary] when git cannot list its worktrees every candidate, and only a candidate, is kept as worktree_list_failed', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      fs.mkdirSync(path.join(rootOf(repo), 'agent-a0000000empt'));
      fs.mkdirSync(path.join(rootOf(repo), 'agent-a0000000gitf'));
      fs.writeFileSync(path.join(rootOf(repo), 'agent-a0000000gitf', '.git'), 'gitdir: /elsewhere\n');
      const faulty = makeFaultyGit({ faults: [{ kind: 'exit', exitCode: 128, when: ['worktree', 'list'] }], passthrough: realExecGit });

      assert.deepStrictEqual(rows(repo, { execGit: faulty }), [[NAME, 'skipped', 'worktree_list_failed']]);
      assert.ok(fs.existsSync(wt));
    });

    test('[independence] a run from a subdirectory of the main checkout sweeps the same root', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      const sub = path.join(repo, 'src');
      fs.mkdirSync(sub);

      assert.deepStrictEqual(verb(sub).json.entries.map((e) => e.status), ['reaped']);
      assert.ok(!fs.existsSync(wt));
    });

    test('[property] a name is harness residue exactly when it is agent-a plus seven or more hex digits (and has a branch)', () => {
      fc.assert(fc.property(fc.integer({ min: 1, max: 12 }), fc.constantFrom('hex', 'upper', 'tail'), (digits, kind) => {
        const base = tmpBase + '-' + Math.random().toString(16).slice(2);
        fs.mkdirSync(base);
        try {
          const repo = adrRepo(base);
          const hex = '1234567890abcdef'.repeat(2).slice(0, digits);
          const name = kind === 'hex' ? `agent-a${hex}` : kind === 'upper' ? `agent-a${hex.toUpperCase()}Z` : `agent-a${hex}-x`;
          residueDir(repo, { name });
          const wantReaped = kind === 'hex' && digits >= 7;
          const got = rows(repo)[0];
          assert.strictEqual(got[1], wantReaped ? 'reaped' : 'skipped', `${name}: ${JSON.stringify(got)}`);
          if (!wantReaped) assert.strictEqual(got[2], 'residue_not_harness_named', name);
        } finally {
          cleanup(base);
        }
      }), { numRuns: 12 });
    });
  });

  describe('D2 no work git lacks', () => {
    for (const [label, mutate] of [
      ['a modified tracked file', (wt) => fs.writeFileSync(path.join(wt, 'README.md'), 'changed\n')],
      ['a deleted tracked file', (wt) => cleanup(path.join(wt, 'README.md'))],
      ['an untracked file that is not ignored', (wt) => fs.writeFileSync(path.join(wt, 'notes.txt'), 'new\n')],
      ['an untracked .gitignore that ignores everything', (wt) => fs.writeFileSync(path.join(wt, '.gitignore'), '*\n')],
      ['an untracked .gitignore at depth', (wt) => { fs.mkdirSync(path.join(wt, 'sub')); fs.writeFileSync(path.join(wt, 'sub', '.gitignore'), '*\n'); }],
      // git reads these as `.gitignore` on a case-insensitive filesystem, where it would hide the untracked work beside
      // it. They pin the any-case walk there; on a case-sensitive filesystem they are plain untracked work.
      ['an untracked .GITIGNORE that ignores everything, beside untracked work', (wt) => { fs.mkdirSync(path.join(wt, 'src')); fs.writeFileSync(path.join(wt, 'src', '.GITIGNORE'), '*\n'); fs.writeFileSync(path.join(wt, 'src', 'new-work.ts'), 'x\n'); }],
      ['an untracked .GitIgnore at the top level', (wt) => fs.writeFileSync(path.join(wt, '.GitIgnore'), '*\n')],
    ]) {
      test(`[regression] ${label} keeps the directory as residue_has_work`, () => {
        const repo = adrRepo();
        const wt = residueDir(repo);
        mutate(wt);

        assert.deepStrictEqual(rows(repo), [[NAME, 'skipped', 'residue_has_work']]);
        assert.ok(fs.existsSync(wt));
      });
    }

    test('[independence] ignored files (a node_modules, a build directory the rules ignore) are disposable', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      fs.mkdirSync(path.join(wt, 'node_modules', 'deep', 'er'), { recursive: true });
      fs.writeFileSync(path.join(wt, 'node_modules', 'deep', 'er', 'f.js'), '1');

      assert.deepStrictEqual(rows(repo), [[NAME, 'reaped', 'unregistered_residue']]);
    });

    test('[independence] the directory may match either harness branch tip: the one it was created from is enough', () => {
      const repo = adrRepo();
      const wt = residueDir(repo, { name: 'agent-a5555555', branch: 'agent-a5555555' });
      git(['branch', 'worktree-agent-a5555555', 'HEAD~1'], repo);

      assert.deepStrictEqual(rows(repo), [['agent-a5555555', 'reaped', 'unregistered_residue']]);
      assert.ok(!fs.existsSync(wt));
    });

    test('[security] a repository hook does not run during the checks (the index writes of the throwaway index fire post-index-change)', (t) => {
      if (process.platform === 'win32') { t.skip('hooks are shell scripts'); return; }
      const repo = adrRepo();
      residueDir(repo);
      const marker = path.join(tmpBase, 'hook-ran');
      const hook = path.join(repo, '.git', 'hooks', 'post-index-change');
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });

      assert.deepStrictEqual(rows(repo), [[NAME, 'reaped', 'unregistered_residue']]);
      assert.ok(!fs.existsSync(marker), 'the hook must not have run');
    });

    test('[boundary] a tip with more top-level names than one listing chunk (100) is still compared: 100, 101 and 201 names', () => {
      for (const extra of [99, 100, 200]) {
        const repo = path.join(tmpBase, `repo-chunk-${extra}`);
        initRepo(repo);
        fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
        for (let i = 0; i < extra; i++) fs.writeFileSync(path.join(repo, `file-${String(i).padStart(3, '0')}.txt`), `${i}\n`);
        git(['add', '-A'], repo);
        git(['commit', '-m', 'many top-level files'], repo);
        residueDir(repo);

        assert.deepStrictEqual(rows(repo), [[NAME, 'reaped', 'unregistered_residue']], `${extra} extra names`);
      }
    });

    test('[boundary] when the throwaway index cannot be made the candidate is kept as residue_unverified and the verb carries on', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      const keys = ['TMPDIR', 'TEMP', 'TMP'];
      const before = keys.map((k) => process.env[k]);
      for (const k of keys) process.env[k] = path.join(tmpBase, 'no-such-tmp-dir');
      let json;
      try {
        ({ json } = verb(repo));
      } finally {
        keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; });
      }

      assert.deepStrictEqual(json.entries.map((e) => [e.status, e.reason]), [['skipped', 'residue_unverified']]);
      assert.notStrictEqual(json.scan, null);
      assert.ok(fs.existsSync(wt));
    });

    test('[boundary] when git cannot compare (read-tree fails) the directory is kept as residue_unverified', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      const faulty = makeFaultyGit({ faults: [{ kind: 'exit', exitCode: 128, when: ['-c', 'core.fsmonitor=false'] }], passthrough: realExecGit });

      assert.deepStrictEqual(rows(repo, { execGit: faulty }), [[NAME, 'skipped', 'residue_unverified']]);
      assert.ok(fs.existsSync(wt));
    });
  });

  describe('D3 disqualifiers', () => {
    test('[security] a file git tracks under the name keeps the directory, whatever the case of the pathspec', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      cleanup(wt);
      fs.mkdirSync(wt, { recursive: true });
      fs.writeFileSync(path.join(wt, 'tracked.txt'), 'committed content\n');
      git(['add', '-f', path.join('.claude', 'worktrees', NAME, 'tracked.txt')], repo);
      git(['commit', '-m', 'track a file under the harness name'], repo);

      assert.deepStrictEqual(rows(repo), [[NAME, 'skipped', 'residue_tracked']]);
      assert.ok(fs.existsSync(path.join(wt, 'tracked.txt')));
    });

    test('[security] a file tracked under a differently-cased spelling of the name keeps the directory (the pathspec is case-insensitive)', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      const other = path.join(rootOf(repo), NAME.toUpperCase());
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(path.join(other, 'tracked.txt'), 'committed\n');
      git(['add', '-f', path.join('.claude', 'worktrees', NAME.toUpperCase(), 'tracked.txt')], repo);
      git(['commit', '-m', 'track under another case'], repo);

      assert.ok(rows(repo).some((r) => r[0] === NAME && r[2] === 'residue_tracked'), JSON.stringify(rows(repo)));
      assert.ok(fs.existsSync(wt));
    });

    test('[security] a repository at any depth keeps the directory, a nested .git entry or a bare layout, even inside node_modules', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      fs.mkdirSync(path.join(wt, 'node_modules', 'pkg', 'vendored', '.GIT'), { recursive: true });
      assert.deepStrictEqual(rows(repo), [[NAME, 'skipped', 'residue_contains_repository']]);
      cleanup(path.join(wt, 'node_modules', 'pkg', 'vendored'));
      for (const n of ['HEAD', 'objects', 'refs']) fs.mkdirSync(path.join(wt, 'node_modules', 'bare', n), { recursive: true });
      assert.deepStrictEqual(rows(repo), [[NAME, 'skipped', 'residue_contains_repository']]);
      assert.ok(fs.existsSync(wt));
    });

    test('[boundary] an entry younger than the race guard keeps the directory silently; at the guard it goes', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      const newest = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((acc, e) => {
        const full = path.join(dir, e.name);
        const s = fs.lstatSync(full);
        const inner = e.isDirectory() ? newest(full) : 0;
        return Math.max(acc, s.mtimeMs, s.ctimeMs, inner);
      }, Math.max(fs.lstatSync(dir).mtimeMs, fs.lstatSync(dir).ctimeMs));
      const youngest = newest(wt);

      assert.deepStrictEqual(rows(repo, { nowMs: youngest + GUARD_MS - 1 }), []);
      assert.ok(fs.existsSync(wt), 'limit-1: kept');
      assert.deepStrictEqual(rows(repo, { nowMs: youngest + GUARD_MS }), [[NAME, 'reaped', 'unregistered_residue']]);
      assert.ok(!fs.existsSync(wt), 'limit: reaped');
    });

    test('[security] a directory holding the process working directory or the sweep root is kept as residue_contains_cwd', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      fs.mkdirSync(path.join(wt, 'node_modules', 'here'), { recursive: true });
      assert.deepStrictEqual(rows(repo, { cwd: path.join(wt, 'node_modules', 'here') }), [[NAME, 'skipped', 'residue_contains_cwd']]);
      assert.ok(fs.existsSync(wt));
    });

    test('[boundary] the walk bound: limit-1 and limit entries are read, limit+1 is kept as residue_unverified', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      let count = 0;
      const countEntries = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { count += 1; if (e.isDirectory()) countEntries(path.join(dir, e.name)); } };
      countEntries(wt);

      assert.deepStrictEqual(rows(repo, { residueWalkLimit: count - 1 }), [[NAME, 'skipped', 'residue_unverified']]);
      assert.deepStrictEqual(rows(repo, { residueWalkLimit: count }), [[NAME, 'reaped', 'unregistered_residue']]);
    });

    test('[security] a link inside the directory is unlinked, never followed: the target survives', (t) => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      const outside = path.join(tmpBase, 'outside-target');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'keep.txt'), 'must survive\n');
      try { fs.symlinkSync(outside, path.join(wt, 'node_modules', 'linked'), 'dir'); } catch { t.skip('cannot create symlinks on this host'); return; }

      assert.deepStrictEqual(rows(repo), [[NAME, 'reaped', 'unregistered_residue']]);
      assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'must survive\n');
    });
  });

  describe('D4 ignored secrets and user data', () => {
    for (const rel of ['.env', '.env.local', '.env.example', path.join('app', '.env'), path.join('.secrets', 'token'), path.join('.planning', 'STATE.md')]) {
      test(`[regression] an ignored ${rel.replace(/\\/g, '/')} the harness did not create keeps the directory as residue_has_user_data`, () => {
        const repo = adrRepo();
        const wt = residueDir(repo);
        fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
        fs.writeFileSync(path.join(wt, rel), 'SECRET=1\n');

        assert.deepStrictEqual(rows(repo), [[NAME, 'skipped', 'residue_has_user_data']]);
        assert.ok(fs.existsSync(path.join(wt, rel)));
      });
    }

    test('[independence] a file the harness copied (same bytes, same path in the main checkout) is not user data', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      fs.writeFileSync(path.join(wt, '.env'), 'SECRET=1\n');
      assert.deepStrictEqual(rows(repo), [[NAME, 'skipped', 'residue_has_user_data']]);

      fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
      assert.deepStrictEqual(rows(repo), [[NAME, 'reaped', 'unregistered_residue']]);
    });

    test('[boundary] a copy that differs, or is larger than 1 MiB, is not a copy', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
      fs.writeFileSync(path.join(wt, '.env'), 'SECRET=2\n');
      assert.deepStrictEqual(rows(repo), [[NAME, 'skipped', 'residue_has_user_data']]);

      const big = Buffer.alloc(1024 * 1024 + 1, 'a');
      fs.writeFileSync(path.join(repo, '.env'), big);
      fs.writeFileSync(path.join(wt, '.env'), big);
      assert.deepStrictEqual(rows(repo), [[NAME, 'skipped', 'residue_has_user_data']]);
      const atLimit = Buffer.alloc(1024 * 1024, 'a');
      fs.writeFileSync(path.join(repo, '.env'), atLimit);
      fs.writeFileSync(path.join(wt, '.env'), atLimit);
      assert.deepStrictEqual(rows(repo), [[NAME, 'reaped', 'unregistered_residue']]);
    });
  });

  describe('D5 removal protocol and the reserved name', () => {
    test('[boundary] a rename that fails keeps the directory as residue_remove_failed', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      assert.deepStrictEqual(rows(repo, { renameDir: () => { throw new Error('EBUSY'); } }), [[NAME, 'skipped', 'residue_remove_failed']]);
      assert.ok(fs.existsSync(wt));
    });

    test('[independence] a rename that fails because a concurrent sweep already took the directory reports no row', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      const taken = (from) => { cleanup(from); throw new Error('ENOENT'); };
      assert.deepStrictEqual(rows(repo, { renameDir: taken }), []);
      assert.ok(!fs.existsSync(wt));
    });

    test('[boundary] a removal that stops partway is renamed back and reported as residue_remove_incomplete', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      const failing = (dir) => { cleanup(path.join(dir, 'node_modules')); throw new Error('EPERM'); };

      assert.deepStrictEqual(rows(repo, { removeDir: failing }), [[NAME, 'skipped', 'residue_remove_incomplete']]);
      assert.ok(fs.existsSync(wt), 'what is left sits at the original path');
      assert.ok(!fs.existsSync(path.join(wt, 'node_modules')));
    });

    test('[boundary] when the rename back fails too, the row names the reserved path where the files are', () => {
      const repo = adrRepo();
      residueDir(repo);
      let renames = 0;
      const realRename = (from, to) => fs.renameSync(from, to);
      const flaky = (from, to) => { renames += 1; if (renames === 2) throw new Error('EBUSY'); realRename(from, to); };

      const result = reapOrphanWorktrees(repo, { nowMs: FAR_FUTURE_MS, renameDir: flaky, removeDir: () => { throw new Error('EPERM'); } });

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].reason, 'residue_remove_incomplete');
      assert.match(path.basename(result[0].path), /^\.gsd-reap-[0-9a-f]{16}$/);
      assert.ok(fs.existsSync(result[0].path));
    });

    test('[security] a root that turns into a link between the checks and the removal keeps the directory as residue_unreadable', (t) => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      let rootChecks = 0;
      const lstat = (p) => {
        const real = fs.lstatSync(p, { throwIfNoEntry: false }) ?? null;
        if (p === rootOf(repo) && real !== null && ++rootChecks > 1) {
          return Object.assign(Object.create(real), { isSymbolicLink: () => true });
        }
        return real;
      };
      void t;
      assert.deepStrictEqual(rows(repo, { lstatSafe: lstat }), [[NAME, 'skipped', 'residue_unreadable']]);
      assert.ok(fs.existsSync(wt));
    });

    test('[security] a directory swapped in while git was being asked is not removed on the old directory\'s evidence', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      let swapped = false;
      const swapping = (args, opts) => {
        if (!swapped && args.includes('--ignored')) {
          swapped = true;
          fs.renameSync(wt, path.join(tmpBase, 'moved-away'));
          fs.mkdirSync(wt);
          fs.writeFileSync(path.join(wt, 'fresh-untracked-work.txt'), 'new work\n');
        }
        return realExecGit(args, opts);
      };

      assert.deepStrictEqual(rows(repo, { execGit: swapping }), [[NAME, 'skipped', 'residue_unreadable']]);
      assert.strictEqual(fs.readFileSync(path.join(wt, 'fresh-untracked-work.txt'), 'utf8'), 'new work\n');
    });

    test('[independence] a reserved-name stub is taken to be this sweep\'s stranded removal: it needs no harness name or branch, and goes when old', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      const stub = path.join(rootOf(repo), '.gsd-reap-0123456789abcdef');
      fs.renameSync(wt, stub);

      assert.deepStrictEqual(rows(repo), [['.gsd-reap-0123456789abcdef', 'reaped', 'unregistered_residue']]);
      assert.ok(!fs.existsSync(stub));
    });

    test('[independence] an empty reserved-name stub (a removal that emptied it but could not remove it) is finished off', () => {
      const repo = adrRepo();
      fs.mkdirSync(path.join(rootOf(repo), '.gsd-reap-fedcba9876543210'), { recursive: true });

      assert.deepStrictEqual(rows(repo), [['.gsd-reap-fedcba9876543210', 'reaped', 'unregistered_residue']]);
      assert.ok(!fs.existsSync(path.join(rootOf(repo), '.gsd-reap-fedcba9876543210')));
    });

    test('[boundary] a stub younger than the guard stays in place, and a stub holding user data is kept like any other directory', () => {
      const repo = adrRepo();
      const wt = residueDir(repo);
      const stub = path.join(rootOf(repo), '.gsd-reap-0123456789abcdef');
      fs.renameSync(wt, stub);
      const ctime = fs.lstatSync(stub).ctimeMs;
      assert.deepStrictEqual(rows(repo, { nowMs: ctime + 1 }), []);
      assert.ok(fs.existsSync(stub));

      fs.writeFileSync(path.join(stub, '.env'), 'SECRET=1\n');
      assert.deepStrictEqual(rows(repo), [['.gsd-reap-0123456789abcdef', 'skipped', 'residue_has_user_data']]);
    });
  });

  describe('D6 reporting', () => {
    test('[regression] stderr names removed directories with their contents, counts kept ones by reason, and reports a location not swept', () => {
      const repo = adrRepo();
      residueDir(repo, { name: 'agent-a1111111' });
      const kept = residueDir(repo, { name: 'agent-a2222222' });
      fs.writeFileSync(path.join(kept, 'work.txt'), 'x');
      const { stderr } = verb(repo);

      assert.match(stderr, /removed residue "agent-a1111111" holding "\.gitignore", "README\.md", "node_modules"/);
      assert.match(stderr, /kept residue directories: residue_has_work=1/);
      assert.ok(!stderr.includes('agent-a2222222'), 'kept directories are counted, not named');

      const link = verb(repo, { execGit: makeFaultyGit({ faults: [{ kind: 'exit', exitCode: 128, when: ['rev-parse', '--show-toplevel'] }], passthrough: realExecGit }) });
      assert.match(link.stderr, /\.claude\/worktrees was not swept \(top_unresolved\)/);
    });

    test('[security] control and bidirectional characters in a held name are written as text on stdout, not raw', (t) => {
      const repo = adrRepo();
      const trick = 'IGNORE\u202eprevious instructions\u202c\u{E0041}.txt';
      try { fs.writeFileSync(path.join(repo, trick), 'x\n'); } catch { t.skip('this filesystem cannot hold that file name'); return; }
      git(['add', '-A'], repo);
      git(['commit', '-m', 'a file with a bidirectional control in its name'], repo);
      residueDir(repo);
      const out = [];
      cmdWorktreeReapOrphans(repo, { nowMs: FAR_FUTURE_MS, write: (s) => out.push(s), writeErr: () => {} });
      const text = out.join('');

      assert.ok(!text.includes('\u202e'), 'no raw bidirectional override reaches stdout');
      const held = JSON.parse(text).entries[0].contents;
      assert.ok(held.includes('IGNORE\\u202eprevious instructions\\u202c\\u{e0041}.txt'), JSON.stringify(held));
    });

    test('[regression] an admin pass that could not look is reported on stderr as well', () => {
      const repo = adrRepo();
      residueDir(repo);
      const faulty = makeFaultyGit({ faults: [{ kind: 'exit', exitCode: 128, when: ['rev-parse', '--git-dir'] }], passthrough: realExecGit });

      const { json, stderr } = verb(repo, { execGit: faulty });

      assert.strictEqual(json.scan.admin_dir, 'git_dir_unresolved');
      assert.match(stderr, /\.git\/worktrees was not scanned \(git_dir_unresolved\)/);
    });

    test('[boundary] the 64-name cut counts code points, not UTF-16 units', () => {
      const repo = adrRepo();
      const emoji = `.env${'\u{1F600}'.repeat(62)}`;
      fs.writeFileSync(path.join(repo, emoji), 'COPIED=1\n');
      residueDir(repo);
      fs.writeFileSync(path.join(rootOf(repo), NAME, emoji), 'COPIED=1\n');

      const { stderr } = verb(repo);

      assert.ok(stderr.includes(`"${'.env' + '\u{1F600}'.repeat(60)}"`), stderr);
    });

    test('[boundary] a name longer than 64 code points is cut, and a directory holding more than five names lists five and an ellipsis', () => {
      const repo = path.join(tmpBase, 'repo-many');
      initRepo(repo);
      fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env*\n');
      for (const n of ['f1', 'f2', 'f3', 'f4', 'f5']) fs.writeFileSync(path.join(repo, n), `${n}\n`);
      git(['add', '-A'], repo);
      git(['commit', '-m', 'files'], repo);
      const longName = `.env${'x'.repeat(80)}`;
      fs.writeFileSync(path.join(repo, longName), 'COPIED=1\n');
      residueDir(repo);
      fs.writeFileSync(path.join(rootOf(repo), NAME, longName), 'COPIED=1\n');

      const { stderr } = verb(repo);

      assert.ok(stderr.includes(`"${longName.slice(0, 64)}"`), stderr);
      assert.ok(!stderr.includes(longName.slice(0, 65)), 'cut at 64 code points');
      assert.match(stderr, /holding [^\n]*, \.\.\.\n/);
    });
  });
});
