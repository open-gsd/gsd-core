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

const {
  reapOrphanWorktrees,
  reapOrphanWorktreesWithScan,
  residueNameList,
  pathCompareKey,
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
const GIT_TIMEOUT_MS = 30000;

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
  const r = runGit(args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  throwIfFailed(r, `git ${args.join(' ')}`);
  return r.stdout;
}

/**
 * An `execGit`-shaped delegate that runs REAL git. Used as `makeFaultyGit`'s
 * `passthrough` so a test can fault one argv and leave every other call intact.
 */
function realExecGit(args, opts = {}) {
  const r = runGit(args, { cwd: opts.cwd, timeoutMs: GIT_TIMEOUT_MS });
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
  runGit(['branch', '-m', 'master', 'main'], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
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
  return { isPidAlive: () => false, mtimeSafe: () => STALE_MTIME, ctimeSafe: () => STALE_MTIME, entryMtimeSafe: () => STALE_MTIME, ...extra };
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
    assert.deepStrictEqual(argvOf(faultyGit), ['rev-parse --git-dir']);
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
    // #4941: the reader is probed twice — the admin directory, then the
    // residue scan's `.claude/worktrees` — and the admin directory once.
    assert.deepStrictEqual(probed.map((d) => path.basename(d)), ['worktrees', 'worktrees']);
    assert.strictEqual(path.basename(path.dirname(probed[0])), '.git', 'the admin directory must be probed exactly once, first');
    assert.strictEqual(path.basename(path.dirname(probed[1])), '.claude');
    // Distinguishes this bail-out from the --git-dir one above: --git-dir DID
    // run and succeed, and nothing on the admin path ran after the listing.
    // #4941: the residue scan then asks git which checkout it is in.
    assert.deepStrictEqual(argvOf(faultyGit), ['rev-parse --git-dir', 'rev-parse --git-common-dir', 'rev-parse --show-cdup']);
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

    // #4941 review: the message is escaped (formatDiagnosticToken), so it is quoted.
    assert.deepStrictEqual(err, ['[gsd] worktree.reap-orphans failed: "boom"\n']);
    // #4941: `scan: null` says no discovery source was read — not an all-clear.
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
      '[gsd] worktree.reap-orphans: 1 orphan(s) skipped — run "gsd-tools query worktree.reap-orphans" and see "entries"\n',
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

// ─── #4941: `.claude/worktrees/` residue git has forgotten ───────────────────
// A harness teardown that does not complete leaves `.claude/worktrees/agent-*`
// with no `.git` file; `git worktree prune` then deletes its admin entry, so
// the admin-dir scan could not see it and the sweep reported
// `{ok:true, reaped:0}` with the directory still on disk. Such residue is now
// REMOVED behind guards (maintainer review 2026-10-10), and every child that
// fails a guard is reported and left — each row below checks the disk.

describe('#4941 regression: reap-orphans removes unregistered .claude/worktrees residue behind guards', () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(resolvedTmpDir(), 'gsd-4941-reap-'));
  });

  afterEach(() => {
    cleanup(tmpBase);
  });

  /** The issue's shape: a harness worktree whose .git file is gone. */
  function makeResidue(repoDir, name) {
    const dir = path.join(repoDir, '.claude', 'worktrees', name);
    git(['worktree', 'add', '-b', `worktree-${name}`, dir, 'HEAD'], repoDir);
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg-a'), { recursive: true });
    fs.unlinkSync(path.join(dir, '.git')); // a linked worktree's .git is a FILE
    return dir;
  }

  function repoWithResidue(name, residueName = 'agent-a0000001') {
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

  test('the issue repro: no admin dir left, the residue is removed and the scan says what was read', () => {
    const { repoDir, residue } = repoWithResidue('noadmin');
    assert.ok(!fs.existsSync(path.join(repoDir, '.git', 'worktrees')), 'fixture premise: admin dir pruned away');
    const residueKey = canonicalPath(residue);

    const { results, scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps());

    assert.deepStrictEqual(rows(results), [[residueKey, 'reaped', 'unregistered_residue']]);
    assert.deepStrictEqual(scan, { admin_dir: 'absent', residue_dir: 'scanned' });
    assert.ok(!fs.existsSync(residue), 'the residue is removed');
  });

  test('residue beside a LIVE harness worktree: only the residue is removed', () => {
    const { repoDir, residue } = repoWithResidue('beside-live');
    const live = path.join(repoDir, '.claude', 'worktrees', 'agent-live');
    git(['worktree', 'add', '-b', 'worktree-agent-live', live, 'HEAD'], repoDir);
    const residueKey = canonicalPath(residue);

    const { results, scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps());

    assert.deepStrictEqual(rows(results), [[residueKey, 'reaped', 'unregistered_residue']]);
    assert.deepStrictEqual(scan, { admin_dir: 'scanned', residue_dir: 'scanned' });
    assert.ok(!fs.existsSync(residue));
    assert.ok(fs.existsSync(path.join(live, '.git')), 'the live worktree must be untouched');
  });

  test('a child not named agent-* is reported and kept — a user\'s directory is not harness residue', () => {
    const repoDir = path.join(tmpBase, 'repo-userdir');
    initRepo(repoDir);
    const notes = plainChild(repoDir, 'notes');
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'residue_not_harness_named' });
    assert.strictEqual(fs.readFileSync(path.join(notes, 'file.txt'), 'utf8'), 'x\n');
  });

  // #4941 review (trek-e): a child the sweep renamed to `.gsd-reap-<hex>` and
  // then could not remove (the process died, or the rename back failed) was
  // rejected by the name check on every later sweep and never reclaimed.
  test('a .gsd-reap-<16 hex> directory stranded mid-removal is reclaimed without a harness branch', () => {
    const repoDir = path.join(tmpBase, 'repo-stranded');
    initRepo(repoDir);
    const stranded = plainChild(repoDir, '.gsd-reap-0123456789abcdef');
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    assert.deepStrictEqual([canonicalPath(row.path), row.status, row.reason], [canonicalPath(stranded), 'reaped', 'unregistered_residue']);
    assert.ok(!fs.existsSync(stranded));
  });

  test('a stranded .gsd-reap-* directory still passes every other guard: tracked or repository-bearing ones are kept', () => {
    const repoDir = path.join(tmpBase, 'repo-stranded-kept');
    initRepo(repoDir);
    const tracked = plainChild(repoDir, '.gsd-reap-aaaaaaaaaaaaaaaa');
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'commit a directory under .claude/worktrees'], repoDir);
    const withRepo = plainChild(repoDir, '.gsd-reap-bbbbbbbbbbbbbbbb');
    fs.mkdirSync(path.join(withRepo, 'nested'));
    git(['init', '-q'], path.join(withRepo, 'nested'));
    fs.writeFileSync(path.join(withRepo, 'nested', 'work.txt'), 'uncommitted\n');
    const results = reapOrphanWorktrees(repoDir, deadOwnerDeps());
    assert.deepStrictEqual(rows(results), [
      [canonicalPath(tracked), 'skipped', 'residue_tracked'],
      [canonicalPath(withRepo), 'skipped', 'residue_contains_repository'],
    ]);
    assert.ok(fs.existsSync(path.join(tracked, 'file.txt')));
    assert.ok(fs.existsSync(path.join(withRepo, 'nested', 'work.txt')));
  });

  for (const name of ['.gsd-reap-0123456789abcde', '.gsd-reap-0123456789abcdef0', '.gsd-reap-0123456789ABCDEF', 'gsd-reap-0123456789abcdef']) {
    test(`a near-miss of the stranded name (${name}) is not this sweep's and is kept`, () => {
      const repoDir = path.join(tmpBase, 'repo-near-miss');
      initRepo(repoDir);
      const child = plainChild(repoDir, name);
      const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
      assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_not_harness_named']);
      assert.ok(fs.existsSync(path.join(child, 'file.txt')));
    });
  }

  test('a child holding a file git tracks is kept — committed content is never residue', () => {
    const repoDir = path.join(tmpBase, 'repo-tracked');
    initRepo(repoDir);
    const committed = plainChild(repoDir, 'agent-a0000c0d');
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'commit a directory under .claude/worktrees'], repoDir);
    git(['branch', 'agent-a0000c0d'], repoDir); // a harness branch, so only the tracked guard keeps it
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'residue_tracked' });
    assert.ok(fs.existsSync(path.join(committed, 'file.txt')));
  });

  // Codex review 2026-10-14: an inherited GIT_INDEX_FILE (a hook, a partial
  // commit) made both tracked checks read an alternate index, so tracked work
  // with uncommitted edits was removed. The checkout's own index decides.
  test('an inherited GIT_INDEX_FILE naming an empty index cannot hide tracked content', () => {
    const repoDir = path.join(tmpBase, 'repo-altindex');
    initRepo(repoDir);
    const committed = plainChild(repoDir, 'agent-a0000a07');
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'commit a directory under .claude/worktrees'], repoDir);
    git(['branch', 'worktree-agent-a0000a07'], repoDir);
    fs.writeFileSync(path.join(committed, 'file.txt'), 'uncommitted edit\n');
    const altIndex = path.join(tmpBase, 'alt-index');
    const saved = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = altIndex; // does not exist: git reads it as an empty index
    let row;
    try {
      row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    } finally {
      if (saved === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = saved;
    }
    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'residue_tracked' });
    assert.strictEqual(fs.readFileSync(path.join(committed, 'file.txt'), 'utf8'), 'uncommitted edit\n');
  });

  /** Run `fn` with `vars` set in process.env (undefined = unset), restoring every one after. */
  function withEnv(vars, fn) {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  /** A checkout tracking `<sub>.claude/worktrees/agent-a0000a07/notes`, edited and uncommitted, with a harness branch. */
  function trackedNotes(repoDir, sub = '') {
    initRepo(repoDir);
    const dir = path.join(repoDir, sub, '.claude', 'worktrees', 'agent-a0000a07');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes'), 'committed\n');
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'track notes under .claude/worktrees'], repoDir);
    git(['branch', 'worktree-agent-a0000a07'], repoDir);
    fs.writeFileSync(path.join(dir, 'notes'), 'uncommitted edit\n');
    return dir;
  }

  // Codex review round 2: git told about ANOTHER repository (inherited
  // GIT_DIR / GIT_WORK_TREE, or core.worktree) while the filesystem sweep
  // stayed on this checkout, so the other repository's empty index and its
  // branch removed this checkout's tracked work. Since #5548 every execGit
  // spawn drops the inherited variables, so git answers about this checkout
  // and its own index keeps the notes. A core.worktree is config, not env, so
  // the sweep still refuses unless the top's own `.git` leads to the git dir
  // git is using.
  for (const [label, redirect] of [
    ['an inherited GIT_DIR naming another repository', (repoDir, donor) => ({ GIT_DIR: path.join(donor, '.git'), GIT_WORK_TREE: undefined })],
    ['an inherited GIT_WORK_TREE naming a nested directory', (repoDir) => ({ GIT_DIR: undefined, GIT_WORK_TREE: path.join(repoDir, 'nested') })],
  ]) {
    test(`${label} is dropped, so this checkout's own index keeps its tracked work`, () => {
      const repoDir = path.join(tmpBase, `repo-env-${label.split(' ')[2]}`);
      const notes = trackedNotes(repoDir);
      fs.mkdirSync(path.join(repoDir, 'nested'));
      const donor = path.join(tmpBase, `donor-${label.split(' ')[2]}`);
      initRepo(donor);
      git(['branch', 'worktree-agent-a0000a07'], donor);
      const { results, scan } = withEnv(redirect(repoDir, donor),
        () => reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps()));
      assert.strictEqual(scan.residue_dir, 'scanned');
      const row = onlyRow(results);
      assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'residue_tracked' });
      assert.strictEqual(fs.readFileSync(path.join(notes, 'notes'), 'utf8'), 'uncommitted edit\n');
    });
  }

  test('core.worktree naming a nested directory sweeps nothing (git_mismatch)', () => {
    const repoDir = path.join(tmpBase, 'repo-wt-config');
    const notes = trackedNotes(repoDir, 'nested');
    const nested = path.join(repoDir, 'nested');
    git(['config', 'core.worktree', nested], repoDir);
    const { results, scan } = withEnv({ GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      () => reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps()));
    assert.ok(!results.some((r) => r.status === 'reaped'), JSON.stringify(results));
    assert.strictEqual(scan.residue_dir, 'git_mismatch');
    assert.strictEqual(fs.readFileSync(path.join(notes, 'notes'), 'utf8'), 'uncommitted edit\n');
  });

  test('when git cannot say what it tracks, nothing is removed (fail closed)', () => {
    const { repoDir, residue } = repoWithResidue('lsfail');
    const faultyGit = makeFaultyGit({ faults: [{ kind: 'exit', exitCode: 128, when: ['ls-files'] }], passthrough: realExecGit });
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps({ execGit: faultyGit })));
    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'residue_tracked' });
    assert.ok(fs.existsSync(residue));
  });

  // An empty directory reclaims nothing, and `git worktree add` accepts an
  // empty existing target (it refuses a non-empty one): left, not reported.
  test('an empty agent-* directory is left alone and not reported', () => {
    const repoDir = path.join(tmpBase, 'repo-empty');
    initRepo(repoDir);
    const empty = path.join(repoDir, '.claude', 'worktrees', 'agent-a0000e00');
    fs.mkdirSync(empty, { recursive: true });
    assert.deepStrictEqual(reapOrphanWorktrees(repoDir, deadOwnerDeps()), []);
    assert.ok(fs.existsSync(empty));
  });

  // Codex review (#5233 round 1) — removal only on positive evidence, through
  // a verified path. Each row's would-be victim must survive on disk.
  test('an agent-* directory with no harness branch (agent-<id> / worktree-agent-<id>) is kept', () => {
    const repoDir = path.join(tmpBase, 'repo-nobranch');
    initRepo(repoDir);
    const dir = plainChild(repoDir, 'agent-a0000e11');
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_no_harness_branch']);
    assert.ok(fs.existsSync(path.join(dir, 'file.txt')));
  });

  test('either harness branch spelling is the marker: agent-<id> and worktree-agent-<id>', () => {
    for (const branch of ['agent-a00000b1', 'worktree-agent-a00000b1']) {
      const repoDir = path.join(tmpBase, `repo-branch-${branch}`);
      initRepo(repoDir);
      const dir = plainChild(repoDir, 'agent-a00000b1');
      fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n'); // the branch tip's one file, unchanged
      excludeLocally(repoDir, 'file.txt');
      git(['branch', branch], repoDir);
      const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
      assert.deepStrictEqual([row.status, row.reason], ['reaped', 'unregistered_residue'], branch);
      assert.ok(!fs.existsSync(dir));
    }
  });

  test('a .claude/worktrees that is a link to a directory INSIDE the checkout is not scanned; tracked content there survives', () => {
    const repoDir = path.join(tmpBase, 'repo-inner-alias');
    initRepo(repoDir);
    const saved = path.join(repoDir, 'saved', 'agent-a0000e91');
    fs.mkdirSync(saved, { recursive: true });
    fs.writeFileSync(path.join(saved, 'precious.txt'), 'keep\n');
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'saved'], repoDir);
    git(['branch', 'agent-a0000e91'], repoDir);
    fs.mkdirSync(path.join(repoDir, '.claude'));
    fs.symlinkSync(path.join(repoDir, 'saved'), path.join(repoDir, '.claude', 'worktrees'), 'junction');
    const { results, scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps());
    assert.deepStrictEqual([results, scan.residue_dir], [[], 'aliased']);
    assert.strictEqual(fs.readFileSync(path.join(saved, 'precious.txt'), 'utf8'), 'keep\n');
  });

  test('.claude/worktrees swapped for an outside link mid-sweep: the outside directory is never removed', () => {
    const { repoDir, residue } = repoWithResidue('swap');
    const outside = path.join(tmpBase, 'outside');
    fs.mkdirSync(path.join(outside, 'agent-a0000001', 'keep'), { recursive: true });
    const residueDir = path.join(repoDir, '.claude', 'worktrees');
    const moved = path.join(tmpBase, 'moved-worktrees');
    let swapped = false;
    // The swap happens after discovery, before the final checks (mtimeSafe is
    // read per candidate in between).
    const results = reapOrphanWorktrees(repoDir, deadOwnerDeps({
      mtimeSafe: () => {
        if (!swapped) {
          swapped = true;
          fs.renameSync(residueDir, moved);
          fs.symlinkSync(outside, residueDir, 'junction');
        }
        return STALE_MTIME;
      },
    }));
    assert.ok(!results.some((r) => r.status === 'reaped'), JSON.stringify(results));
    assert.ok(fs.existsSync(path.join(outside, 'agent-a0000001', 'keep')), 'the outside directory survives');
    assert.ok(fs.existsSync(path.join(moved, path.basename(residue))), 'and so does the moved residue');
  });

  // Codex review round 2 (each reproduced against the previous head).
  test('a swap of .claude/worktrees for an outside link AFTER the final checks is refused, not followed', () => {
    const { repoDir, residue } = repoWithResidue('lateswap');
    const outside = path.join(tmpBase, 'late-outside');
    fs.mkdirSync(path.join(outside, 'agent-a0000001', 'keep'), { recursive: true });
    const residueDir = path.join(repoDir, '.claude', 'worktrees');
    const moved = path.join(tmpBase, 'late-moved');
    const gitProbe = path.join(canonicalPath(residueDir), 'agent-a0000001', '.git');
    let probes = 0;
    const realLstat = fs.lstatSync;
    const results = withFaultyFs({
      lstatSync: (p, ...rest) => {
        // The child's `.git` is probed at discovery and again in the final
        // check; swap the parent during that final probe.
        if (p === gitProbe && ++probes === 2) {
          fs.renameSync(residueDir, moved);
          fs.symlinkSync(outside, residueDir, 'junction');
        }
        return realLstat(p, ...rest);
      },
    }, () => reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    assert.strictEqual(probes >= 2, true, 'the final check ran');
    assert.ok(!results.some((r) => r.status === 'reaped'), JSON.stringify(results));
    assert.ok(fs.existsSync(path.join(outside, 'agent-a0000001', 'keep')), 'the outside directory survives');
    assert.ok(fs.existsSync(path.join(moved, path.basename(residue))), 'and so does the moved residue');
  });

  test('a repository inside node_modules keeps the residue (node_modules is walked)', () => {
    const { repoDir, residue } = repoWithResidue('nm-repo');
    const pkg = path.join(residue, 'node_modules', 'local-package');
    fs.mkdirSync(pkg, { recursive: true });
    git(['init', '-q'], pkg);
    fs.writeFileSync(path.join(pkg, 'work.txt'), 'uncommitted\n');
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_contains_repository']);
    assert.ok(fs.existsSync(path.join(pkg, 'work.txt')));
  });

  /**
   * Replace the residue's contents with a known layout the walk reads in
   * exactly FOUR entries: the residue's own three (`a`, `b`, `deep/`), then
   * `deep`'s one — a repository pointer, or a plain file when `withRepo` is false.
   */
  function layoutResidue(residue, withRepo) {
    for (const entry of fs.readdirSync(residue)) cleanup(path.join(residue, entry));
    fs.writeFileSync(path.join(residue, 'a'), 'a\n');
    fs.writeFileSync(path.join(residue, 'b'), 'b\n');
    fs.mkdirSync(path.join(residue, 'deep'));
    fs.writeFileSync(path.join(residue, 'deep', withRepo ? '.git' : 'c'), withRepo ? 'gitdir: /elsewhere/.git\n' : 'c\n');
  }
  const WALK_ENTRIES = 4;

  // Review 2026-10-14 Minor 1: the walk bound is fail-closed at every side of
  // it. A repository the walk reaches only on its last read keeps the residue
  // at limit-1 (bound passed first: unverified), limit and limit+1 (found).
  for (const [label, limit, reason] of [
    ['limit-1', WALK_ENTRIES - 1, 'residue_unverified'],
    ['limit', WALK_ENTRIES, 'residue_contains_repository'],
    ['limit+1', WALK_ENTRIES + 1, 'residue_contains_repository'],
  ]) {
    test(`a repository on the walk's last read keeps the residue at walk bound ${label} (${reason})`, () => {
      const { repoDir, residue } = repoWithResidue(`walk-repo-${limit}`);
      layoutResidue(residue, true);
      const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps({ residueWalkLimit: limit })));
      assert.deepStrictEqual([row.status, row.reason], ['skipped', reason]);
      assert.ok(fs.existsSync(path.join(residue, 'deep', '.git')), 'the residue survives');
    });
  }

  test('the walk bound counts every entry read: a clean residue one entry past it is kept, one at it is removed', () => {
    const over = repoWithResidue('walk-clean-over');
    layoutResidue(over.residue, false);
    const row = onlyRow(reapOrphanWorktrees(over.repoDir, deadOwnerDeps({ residueWalkLimit: WALK_ENTRIES - 1 })));
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_unverified']);
    assert.ok(fs.existsSync(path.join(over.residue, 'deep', 'c')), 'the residue survives');

    const at = repoWithResidue('walk-clean-at');
    layoutResidue(at.residue, false);
    // Removable only with nothing git lacks: the branch tip's README.md back
    // (one more entry for the walk to count) and the layout ignored.
    fs.writeFileSync(path.join(at.residue, 'README.md'), '# Test\n');
    excludeLocally(at.repoDir, '/a', '/b', '/deep/');
    const removed = onlyRow(reapOrphanWorktrees(at.repoDir, deadOwnerDeps({ residueWalkLimit: WALK_ENTRIES + 1 })));
    assert.deepStrictEqual([removed.status, removed.reason], ['reaped', 'unregistered_residue']);
    assert.ok(!fs.existsSync(at.residue));
  });

  test('an unreadable subdirectory keeps the residue as residue_unverified — what the walk cannot read may hold a repository', (t) => {
    if (process.platform === 'win32') {
      t.skip('chmod 000 does not make a directory unreadable on Windows');
      return;
    }
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('root reads a mode-000 directory');
      return;
    }
    const { repoDir, residue } = repoWithResidue('walk-unreadable');
    const locked = path.join(residue, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'work.txt'), 'uncommitted\n');
    const mode = fs.statSync(locked).mode;
    fs.chmodSync(locked, 0o000);
    try {
      const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
      assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_unverified']);
    } finally {
      fs.chmodSync(locked, mode);
    }
    assert.ok(fs.existsSync(path.join(locked, 'work.txt')), 'the residue survives');
  });

  test('a bare agent- child has no id and is not harness-named', () => {
    const repoDir = path.join(tmpBase, 'repo-bare-agent');
    initRepo(repoDir);
    const bare = plainChild(repoDir, 'agent-');
    git(['branch', 'worktree-agent-'], repoDir);
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_not_harness_named']);
    assert.ok(fs.existsSync(path.join(bare, 'file.txt')));
  });

  test('a checkout whose path ends in a space sweeps itself, never a same-named sibling', (t) => {
    if (process.platform === 'win32') {
      t.skip('a trailing space is not a valid Windows path component');
      return;
    }
    const spaced = path.join(tmpBase, 'checkout ');
    const sibling = path.join(tmpBase, 'checkout');
    initRepo(spaced);
    initRepo(sibling);
    const victim = makeResidue(sibling, 'agent-a0000de0');
    fs.writeFileSync(path.join(victim, 'work.txt'), 'sibling work\n');
    const { results, scan } = reapOrphanWorktreesWithScan(spaced, deadOwnerDeps());
    assert.deepStrictEqual([results, scan.residue_dir], [[], 'absent']);
    assert.ok(fs.existsSync(path.join(victim, 'work.txt')), 'the sibling repository\'s directory survives');
  });

  // Codex review round 3 (user-approved), each reproduced against 8b1d5b951.
  test('a swap of .claude/worktrees at the moment of removal moves nothing outside and deletes nothing', () => {
    const { repoDir, residue } = repoWithResidue('renameswap');
    const outside = path.join(tmpBase, 'rs-outside');
    fs.mkdirSync(path.join(outside, 'agent-a0000001', 'keep'), { recursive: true });
    const residueDir = path.join(repoDir, '.claude', 'worktrees');
    const moved = path.join(tmpBase, 'rs-moved');
    const realRename = fs.renameSync;
    let swapped = false;
    const results = withFaultyFs({
      renameSync: (from, to) => {
        // The swap lands just before the reaper's own rename.
        if (!swapped && String(to).includes('.gsd-reap-')) {
          swapped = true;
          realRename(residueDir, moved);
          fs.symlinkSync(outside, residueDir, 'junction');
        }
        return realRename(from, to);
      },
    }, () => reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    assert.ok(swapped, 'the swap ran');
    assert.ok(!results.some((r) => r.status === 'reaped'), JSON.stringify(results));
    assert.ok(fs.existsSync(path.join(outside, 'agent-a0000001', 'keep')), 'the outside directory is back under its own name');
    assert.ok(fs.existsSync(path.join(moved, path.basename(residue))), 'the residue survives');
  });

  test('a repository pointer named .GIT (any case) keeps the residue', () => {
    const { repoDir, residue } = repoWithResidue('gitcase');
    const inner = path.join(residue, 'project');
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(inner, '.GIT'), 'gitdir: /elsewhere/.git\n');
    fs.writeFileSync(path.join(inner, 'work.txt'), 'uncommitted\n');
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_contains_repository']);
    assert.ok(fs.existsSync(path.join(inner, 'work.txt')));
  });

  test('a registered worktree under a checkout whose path holds a newline is never residue', (t) => {
    if (process.platform === 'win32') {
      t.skip('a newline is not a valid Windows path character');
      return;
    }
    const repoDir = path.join(tmpBase, 'repo\nline');
    initRepo(repoDir);
    const live = makeResidue(repoDir, 'agent-live'); // .git file gone, NOT pruned: still registered
    fs.writeFileSync(path.join(live, 'work.txt'), 'uncommitted\n');
    const faultyGit = makeFaultyGit({ faults: [{ kind: 'exit', exitCode: 1, when: ['worktree', 'prune'] }], passthrough: realExecGit });
    const results = reapOrphanWorktrees(repoDir, deadOwnerDeps({ execGit: faultyGit }));
    assert.ok(!results.some((r) => r.status === 'reaped'), JSON.stringify(results));
    assert.ok(fs.existsSync(path.join(live, 'work.txt')));
  });

  test('a tracked directory renamed to another Unicode normalization form is kept', () => {
    const repoDir = path.join(tmpBase, 'repo-nfd');
    initRepo(repoDir);
    git(['config', 'core.precomposeunicode', 'false'], repoDir);
    const nfc = 'agent-café';
    const nfd = 'agent-café';
    plainChild(repoDir, nfc);
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'track'], repoDir);
    const wt = path.join(repoDir, '.claude', 'worktrees');
    fs.renameSync(path.join(wt, nfc), path.join(wt, 'agent-a0000f00'));
    fs.renameSync(path.join(wt, 'agent-a0000f00'), path.join(wt, nfd));
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps({ execGit: branchExists(() => true) })));
    // #4941 review: a harness id is `a` + hex, so a non-ASCII name is now kept
    // by the name check, before the tracked check is reached.
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_not_harness_named']);
    assert.ok(fs.readdirSync(wt).length === 1 && fs.existsSync(path.join(wt, fs.readdirSync(wt)[0], 'file.txt')));
  });

  for (const [label, plant] of [
    ['a bare repository', (dir) => git(['init', '-q', '--bare', dir], tmpBase)],
    ['a repository nested inside it', (dir) => {
      const inner = path.join(dir, 'project');
      fs.mkdirSync(inner, { recursive: true });
      git(['init', '-q'], inner);
      fs.writeFileSync(path.join(inner, 'work.txt'), 'uncommitted\n');
    }],
  ]) {
    test(`an agent-* directory that is or holds ${label} is kept`, () => {
      const repoDir = path.join(tmpBase, `repo-${label.split(' ').pop()}`);
      initRepo(repoDir);
      const dir = path.join(repoDir, '.claude', 'worktrees', 'agent-a0000e90');
      fs.mkdirSync(dir, { recursive: true });
      plant(dir);
      git(['branch', 'agent-a0000e90'], repoDir);
      const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
      assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_contains_repository']);
      assert.ok(fs.readdirSync(dir).length > 0);
    });
  }

  test('a tracked directory renamed by case only is still tracked (case-insensitive pathspec)', () => {
    const repoDir = path.join(tmpBase, 'repo-case');
    initRepo(repoDir);
    plainChild(repoDir, 'agent-A00000CA');
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'track'], repoDir);
    fs.renameSync(path.join(repoDir, '.claude', 'worktrees', 'agent-A00000CA'), path.join(repoDir, '.claude', 'worktrees', 'agent-a0000f00'));
    fs.renameSync(path.join(repoDir, '.claude', 'worktrees', 'agent-a0000f00'), path.join(repoDir, '.claude', 'worktrees', 'agent-a00000ca'));
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps({ execGit: branchExists(() => true) })));
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_tracked']);
    assert.ok(fs.existsSync(path.join(repoDir, '.claude', 'worktrees', 'agent-a00000ca', 'file.txt')));
  });

  test('a tracked directory whose POSIX name holds a backslash is kept', (t) => {
    if (process.platform === 'win32') {
      t.skip('a backslash is a path separator on Windows');
      return;
    }
    const repoDir = path.join(tmpBase, 'repo-backslash');
    initRepo(repoDir);
    const dir = plainChild(repoDir, 'agent-docs\\archive');
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'track'], repoDir);
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps({ execGit: branchExists(() => true) })));
    // #4941 review: kept by the name check (a harness id is `a` + hex).
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_not_harness_named']);
    assert.ok(fs.existsSync(path.join(dir, 'file.txt')));
  });

  // trek-e review 5638711345 (Minor 2): a removal that throws may already have
  // deleted part of the directory, so it is never reported as left in place.
  test('a removal that throws is reported as residue_remove_incomplete', () => {
    const { repoDir, residue } = repoWithResidue('rmfail');
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps({ removeDir: () => { throw new Error('EBUSY: injected'); } })));
    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'residue_remove_incomplete' });
    assert.ok(fs.existsSync(residue));
  });

  test('a real removal that stops partway is residue_remove_incomplete, and stderr says part may be deleted', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX mode bits do not deny unlinking on Windows');
      return;
    }
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('root unlinks inside a mode-555 directory');
      return;
    }
    const { repoDir, residue } = repoWithResidue('rm-partway');
    excludeLocally(repoDir, '/build.log', '/locked/');
    fs.writeFileSync(path.join(residue, 'build.log'), 'log\n');
    const locked = path.join(residue, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'kept.txt'), 'kept\n');
    const mode = fs.statSync(locked).mode;
    fs.chmodSync(locked, mode & ~0o222); // no write bits: its entries cannot be unlinked
    let json;
    let err;
    try {
      ({ json, err } = runCli(repoDir));
    } finally {
      fs.chmodSync(locked, mode);
    }
    assert.deepStrictEqual(json.entries.map((e) => [canonicalPath(e.path), e.status, e.reason]),
      [[canonicalPath(residue), 'skipped', 'residue_remove_incomplete']]);
    assert.strictEqual(json.reaped, 0);
    assert.ok(fs.existsSync(path.join(locked, 'kept.txt')), 'what could not be removed is back under the original name');
    assert.deepStrictEqual(err, [
      '[gsd] worktree.reap-orphans: removing 1 directory under .claude/worktrees failed partway, ' +
      'so part of what it held may already be deleted; the command\'s JSON "entries" lists each one\n',
    ]);
  });

  // Codex review: when the removal fails and the rename back fails too (here,
  // the original path was recreated meanwhile), the files stay under the
  // reserved name, and the row must name that path, not the vacated original.
  test('a failed removal that cannot be renamed back reports the .gsd-reap-* path holding the files', (t) => {
    if (process.platform === 'win32') {
      t.skip('a rename onto a non-empty directory fails differently on Windows');
      return;
    }
    const { repoDir, residue } = repoWithResidue('rmfail-stuck');
    const removeDir = () => {
      fs.mkdirSync(residue);
      fs.writeFileSync(path.join(residue, 'new.txt'), 'recreated\n');
      throw new Error('EBUSY: injected');
    };
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps({ removeDir })));
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_remove_incomplete']);
    assert.match(path.basename(row.path), /^\.gsd-reap-[0-9a-f]{16}$/u);
    assert.ok(fs.existsSync(path.join(row.path, 'node_modules')), 'the reported path holds the residue');
  });

  // trek-e review 5563200267 (Minor 1): a sweep's rename to the reserved name
  // keeps the directory's mtime, so a second sweep running at the same time saw
  // the first one's in-flight `.gsd-reap-<hex>` as stranded and removed it under
  // it. The rename sets the ctime, so a reserved name changed inside the guard
  // window is left for a later sweep. guardMs-1 is still in flight; guardMs and
  // guardMs+1 are stranded and reclaimed.
  for (const [age, removed] of [[-1, false], [0, true], [1, true]]) {
    test(`a .gsd-reap-<16 hex> renamed guardMs${age < 0 ? '-1' : age > 0 ? '+1' : ''} ago is ${removed ? 'reclaimed' : 'left alone'}`, () => {
      const guardMs = 60_000;
      const repoDir = path.join(tmpBase, `repo-inflight${age}`);
      initRepo(repoDir);
      const stranded = plainChild(repoDir, '.gsd-reap-0123456789abcdef');
      // The mtime is a day older than the ctime, so only the ctime decides.
      const renamedAt = 86_400_000;
      const results = reapOrphanWorktrees(repoDir, deadOwnerDeps({
        reapMtimeGuardMs: guardMs,
        mtimeSafe: () => new Date(0),
        ctimeSafe: () => new Date(renamedAt),
        nowMs: renamedAt + guardMs + age,
      }));
      assert.deepStrictEqual(rows(results), removed ? [[canonicalPath(stranded), 'reaped', 'unregistered_residue']] : []);
      assert.strictEqual(fs.existsSync(path.join(stranded, 'file.txt')), !removed);
    });
  }

  test('a .gsd-reap-<16 hex> whose ctime cannot be read is reported, not removed', () => {
    const repoDir = path.join(tmpBase, 'repo-inflight-unknown');
    initRepo(repoDir);
    const stranded = plainChild(repoDir, '.gsd-reap-0123456789abcdef');
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps({ ctimeSafe: () => null })));
    assert.deepStrictEqual([canonicalPath(row.path), row.status, row.reason], [canonicalPath(stranded), 'skipped', 'residue_age_unknown']);
    assert.ok(fs.existsSync(path.join(stranded, 'file.txt')));
  });

  // trek-e review 5593733152 (Minor 1, Nit 2): the guard needs this platform's
  // rename to advance the directory's ctime. Measured against the filesystem's
  // own clock, not the wall clock: wait until a probe write is stamped a
  // millisecond past the directory's ctime, rename, and require the ctime to
  // have moved — then sweep at the instant the creation ctime would be exactly
  // guardMs old (reclaimed, per the rows above) with the real ctime.
  test('a rename advances the directory\'s real ctime, so a .gsd-reap-<16 hex> renamed just now is left alone', () => {
    const guardMs = 60_000;
    const repoDir = path.join(tmpBase, 'repo-inflight-real');
    initRepo(repoDir);
    const residue = plainChild(repoDir, 'agent-a0000f11');
    const createdMs = Math.floor(fs.statSync(residue).ctimeMs);
    const probe = path.join(tmpBase, 'ctime-probe');
    let stamped = createdMs;
    for (let i = 0; i < 100_000 && stamped <= createdMs; i++) {
      fs.writeFileSync(probe, String(i));
      stamped = Math.floor(fs.statSync(probe).mtimeMs);
    }
    assert.ok(stamped > createdMs, 'the filesystem clock moved past the directory\'s ctime');
    const stranded = path.join(path.dirname(residue), '.gsd-reap-0123456789abcdef');
    fs.renameSync(residue, stranded);
    assert.ok(Math.floor(fs.statSync(stranded).ctimeMs) > createdMs, `this platform's rename advanced the ctime (${process.platform})`);
    const results = reapOrphanWorktrees(repoDir, { isPidAlive: () => false, mtimeSafe: () => STALE_MTIME, reapMtimeGuardMs: guardMs, nowMs: createdMs + guardMs });
    assert.deepStrictEqual(results, []);
    assert.ok(fs.existsSync(path.join(stranded, 'file.txt')));
  });

  // trek-e review 5593733152 (Nit 3): a concurrent sweep that renames the
  // candidate away just before this sweep's own rename leaves this sweep a
  // failed rename of a path that moved — not a removal failure to report.
  // A rename that fails with the candidate still in place is still reported.
  for (const [label, takenAway] of [['a concurrent sweep took it', true], ['it is still in place', false]]) {
    test(`a failed rename to the reserved name when ${label} -> ${takenAway ? 'no row' : 'residue_remove_failed'}`, () => {
      const { repoDir, residue } = repoWithResidue(`rename-race-${takenAway}`);
      const other = path.join(path.dirname(residue), '.gsd-reap-ffffffffffffffff');
      const realRename = fs.renameSync;
      let raced = false;
      const results = withFaultyFs({
        renameSync: (from, to) => {
          if (path.basename(String(to)).startsWith('.gsd-reap-')) {
            if (takenAway && !raced) realRename(from, other);
            raced = true;
            // Every attempt, since retryRenameSync retries a transient code.
            if (!takenAway) throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' });
          }
          return realRename(from, to);
        },
      }, () => reapOrphanWorktrees(repoDir, deadOwnerDeps()));
      assert.ok(raced, 'the race ran');
      assert.deepStrictEqual(rows(results), takenAway ? [] : [[canonicalPath(residue), 'skipped', 'residue_remove_failed']]);
      assert.ok(fs.existsSync(takenAway ? other : residue), 'the residue is where the race left it');
    });
  }

  // Codex review of this round: a candidate missing because `.claude/worktrees`
  // itself moved was not taken by another sweep, so the failure is reported.
  // trek-e review 5608091528 (Minor 1): so is one whose parent was moved aside
  // and a fresh directory made in its place — still a real directory, but not
  // the one this sweep verified.
  for (const [label, recreated] of [['moved', false], ['moved and was recreated in place', true]]) {
    test(`a failed rename to the reserved name after .claude/worktrees ${label} -> residue_remove_failed`, () => {
      const { repoDir, residue } = repoWithResidue(`rename-race-parent-${recreated}`);
      const residueDir = path.dirname(residue);
      const moved = path.join(tmpBase, `rename-race-parent-${recreated}-moved`);
      const realRename = fs.renameSync;
      let raced = false;
      const results = withFaultyFs({
        renameSync: (from, to) => {
          if (!raced && path.basename(String(to)).startsWith('.gsd-reap-')) {
            raced = true;
            realRename(residueDir, moved);
            if (recreated) fs.mkdirSync(residueDir);
          }
          return realRename(from, to);
        },
      }, () => reapOrphanWorktrees(repoDir, deadOwnerDeps()));
      assert.ok(raced, 'the move ran');
      assert.deepStrictEqual(rows(results), [[canonicalPath(residue), 'skipped', 'residue_remove_failed']]);
      assert.ok(fs.existsSync(path.join(moved, path.basename(residue))), 'the residue moved with its parent');
    });
  }

  // trek-e review 5593733152 (Nit 4): the reserved name is exactly
  // `.gsd-reap-` and 16 lower-case hex digits; one digit more or fewer, or any
  // other character, is not this sweep's and is held to the harness-name rule.
  test('property: only `.gsd-reap-` + 16 lower-case hex is taken as a stranded removal', () => {
    const fc = require('fast-check');
    const hex = '0123456789abcdef';
    const hexOf = (n) => fc.array(fc.constantFrom(...hex), { minLength: n, maxLength: n }).map((a) => a.join(''));
    const name = fc.oneof(
      hexOf(16).map((h) => ({ suffix: h, stranded: true })),
      fc.constantFrom(15, 17).chain(hexOf).map((h) => ({ suffix: h, stranded: false })),
      fc.tuple(hexOf(15), fc.constantFrom(...'ABCDEFgxz-_.'), fc.nat(15))
        .map(([h, bad, at]) => ({ suffix: h.slice(0, at) + bad + h.slice(at), stranded: false })),
    );
    const repoDir = path.join(tmpBase, 'repo-stranded-property');
    initRepo(repoDir);
    fc.assert(fc.property(name, ({ suffix, stranded }) => {
      const child = plainChild(repoDir, `.gsd-reap-${suffix}`);
      // trek-e review 5608091528 (Nit 4): a failing run removes its directory
      // too, so the shrunk counterexample is not obscured by a leftover row.
      try {
        const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
        assert.deepStrictEqual([row.status, row.reason], stranded ? ['reaped', 'unregistered_residue'] : ['skipped', 'residue_not_harness_named']);
      } finally {
        cleanup(child);
      }
    }), { numRuns: 40 });
  });

  // The guard applies to the reserved name only: a harness-named residue is
  // aged by its mtime, as before.
  test('an agent-<id> residue is not held back by a fresh ctime', () => {
    const { repoDir, residue } = repoWithResidue('ctime-agent');
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps({ ctimeSafe: () => new Date(Date.now()) })));
    assert.deepStrictEqual([canonicalPath(row.path), row.status], [canonicalPath(residue), 'reaped']);
  });

  // trek-e review 5563200267 (Nit 1a): a stranded name is still under the mtime guard.
  test('a .gsd-reap-<16 hex> directory newer than the mtime guard is not reported and not removed', () => {
    const repoDir = path.join(tmpBase, 'repo-stranded-young');
    initRepo(repoDir);
    const stranded = plainChild(repoDir, '.gsd-reap-0123456789abcdef');
    assert.deepStrictEqual(reapOrphanWorktrees(repoDir, deadOwnerDeps({ mtimeSafe: () => new Date(1000), nowMs: 1000 })), []);
    assert.ok(fs.existsSync(path.join(stranded, 'file.txt')));
  });

  // trek-e review 5563200267 (Nit 1b): when the renamed directory is not where
  // it should have landed and the rename back fails, the row names the
  // reserved path, the one left holding the files.
  test('a rename that did not land and cannot be renamed back reports the .gsd-reap-* path', (t) => {
    if (process.platform === 'win32') {
      t.skip('a rename onto a non-empty directory fails differently on Windows');
      return;
    }
    const { repoDir, residue } = repoWithResidue('notlanded-stuck');
    const realRename = fs.renameSync;
    let held = null;
    const results = withFaultyFs({
      renameSync: (from, to) => {
        if (held === null && path.basename(String(to)).startsWith('.gsd-reap-')) {
          // The rename lands somewhere else (the reserved name is only a link
          // to it), and the original path is recreated, so the rename back fails.
          held = path.join(tmpBase, 'notlanded-held');
          realRename(from, held);
          fs.symlinkSync(held, to, 'junction');
          fs.mkdirSync(residue);
          fs.writeFileSync(path.join(residue, 'new.txt'), 'recreated\n');
          return undefined;
        }
        return realRename(from, to);
      },
    }, () => reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    assert.ok(held !== null, 'the reaper renamed the residue');
    const row = onlyRow(results);
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_unreadable']);
    assert.match(path.basename(row.path), /^\.gsd-reap-[0-9a-f]{16}$/u);
    assert.ok(fs.existsSync(path.join(row.path, 'node_modules')), 'the reported path leads to the residue');
  });

  test('a residue newer than the mtime guard is not reported and not removed (it may be mid-creation)', () => {
    const { repoDir, residue } = repoWithResidue('fresh');
    assert.deepStrictEqual(reapOrphanWorktrees(repoDir, { mtimeSafe: () => new Date(1000), nowMs: 1000 }), []);
    assert.ok(fs.existsSync(residue));
  });

  // The guard is `age < guardMs` → leave: guardMs-1 is still mid-creation and
  // survives on disk; guardMs and guardMs+1 are residue and are removed.
  for (const [age, removed] of [[-1, false], [0, true], [1, true]]) {
    test(`a residue aged guardMs${age < 0 ? '-1' : age > 0 ? '+1' : ''} is ${removed ? 'removed' : 'left on disk'}`, () => {
      const guardMs = 60_000;
      const { repoDir, residue } = repoWithResidue(`guard${age}`);
      const results = reapOrphanWorktrees(repoDir, deadOwnerDeps({
        reapMtimeGuardMs: guardMs,
        mtimeSafe: () => new Date(0),
        nowMs: guardMs + age,
      }));
      assert.deepStrictEqual(results.map((r) => r.reason), removed ? ['unregistered_residue'] : []);
      assert.strictEqual(fs.existsSync(residue), !removed);
    });
  }

  test('a symlink or junction INSIDE the residue is unlinked, never followed: its target survives', () => {
    const { repoDir, residue } = repoWithResidue('innerlink');
    excludeLocally(repoDir, '/node_modules/');
    const target = path.join(tmpBase, 'outside-target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep\n');
    fs.symlinkSync(target, path.join(residue, 'node_modules', 'linked'), 'junction');

    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));

    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'reaped', reason: 'unregistered_residue' });
    assert.ok(!fs.existsSync(residue));
    assert.strictEqual(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep\n');
  });

  test('no .claude/worktrees at all scans as absent', () => {
    const repoDir = path.join(tmpBase, 'repo-absent');
    initRepo(repoDir);
    const { results, scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps());
    assert.deepStrictEqual(results, []);
    assert.deepStrictEqual(scan, { admin_dir: 'absent', residue_dir: 'absent' });
  });

  // Minor 7: "missing" and "unreadable" are distinct answers for the admin dir.
  test('an admin dir that exists but cannot be listed scans as unreadable, not absent', () => {
    const { repoDir } = repoWithResidue('adminunreadable');
    const admin = path.join(repoDir, '.git', 'worktrees');
    fs.mkdirSync(admin, { recursive: true });
    const { scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps({
      readDirSafe: (dir) => (canonicalPath(dir) === canonicalPath(admin) ? null : fs.readdirSync(dir)),
    }));
    assert.strictEqual(scan.admin_dir, 'unreadable');
  });

  test('a .claude/worktrees that cannot be listed scans as unreadable, not absent', () => {
    const repoDir = path.join(tmpBase, 'repo-unreadable');
    initRepo(repoDir);
    fs.mkdirSync(path.join(repoDir, '.claude'));
    fs.writeFileSync(path.join(repoDir, '.claude', 'worktrees'), 'not a directory\n'); // readdir → ENOTDIR
    const { results, scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps());
    assert.deepStrictEqual(results, []);
    assert.strictEqual(scan.residue_dir, 'unreadable');
  });

  // Codex review of this round: a `.claude` the sweep cannot traverse hides
  // whether `.claude/worktrees` exists, so it did not look: unreadable, not absent.
  test('a .claude that cannot be traversed scans as unreadable, not absent', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX mode bits do not deny traversal on Windows');
      return;
    }
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('root traverses a mode-000 directory');
      return;
    }
    const { repoDir } = repoWithResidue('claude-untraversable');
    const claude = path.join(repoDir, '.claude');
    const mode = fs.statSync(claude).mode;
    fs.chmodSync(claude, 0o000);
    let scan;
    try {
      ({ scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps()));
    } finally {
      fs.chmodSync(claude, mode);
    }
    assert.strictEqual(scan.residue_dir, 'unreadable');
  });

  // #4941 review: the admin-dir mirror of the row above. A git dir behind a
  // directory the sweep cannot traverse (a --separate-git-dir location chmod'ed
  // after git resolved it) hides whether `worktrees/` exists: unreadable.
  test('an admin dir behind an untraversable directory scans as unreadable, not absent', (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX mode bits do not deny traversal on Windows');
      return;
    }
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('root traverses a mode-000 directory');
      return;
    }
    const { repoDir } = repoWithResidue('admin-untraversable');
    const locked = path.join(tmpBase, 'locked-gitdir-parent');
    fs.mkdirSync(path.join(locked, 'gitdir', 'worktrees'), { recursive: true });
    const execGit = (args, opts) => (args[0] === 'rev-parse' && args[1] === '--git-dir'
      ? okResult(`${path.join(locked, 'gitdir')}\n`)
      : realExecGit(args, opts));
    const mode = fs.statSync(locked).mode;
    fs.chmodSync(locked, 0o000);
    let scan;
    try {
      ({ scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps({ execGit })));
    } finally {
      fs.chmodSync(locked, mode);
    }
    assert.strictEqual(scan.admin_dir, 'unreadable');
  });

  test('run from a linked worktree, nothing of main\'s residue is touched and the scan says not_main_checkout', () => {
    const { repoDir, residue } = repoWithResidue('linked');
    const linked = path.join(tmpBase, 'linked-wt');
    git(['worktree', 'add', '-b', 'linked-branch', linked, 'HEAD'], repoDir);
    const { results, scan } = reapOrphanWorktreesWithScan(linked, deadOwnerDeps());
    assert.ok(!results.some((r) => r.reason === 'unregistered_residue'));
    assert.strictEqual(scan.residue_dir, 'not_main_checkout');
    assert.ok(fs.existsSync(residue));
  });

  // A non-ENOENT failure probing a child (or its `.git`) proves nothing about
  // it, so it is reported as unreadable and left — never removed.
  for (const probe of ['child', '.git']) {
    test(`a non-ENOENT lstat failure on the ${probe} reports the child residue_unreadable and leaves it`, () => {
      const { repoDir, residue } = repoWithResidue(`lstat-${probe === '.git' ? 'git' : 'child'}`);
      const target = probe === '.git' ? path.join(residue, '.git') : residue;
      const realLstat = fs.lstatSync;
      const results = withFaultyFs({
        lstatSync: (p, ...rest) => {
          if (p === target) throw Object.assign(new Error('EACCES: injected'), { code: 'EACCES' });
          return realLstat(p, ...rest);
        },
      }, () => reapOrphanWorktrees(repoDir, deadOwnerDeps()));
      assert.deepStrictEqual(rows(results), [[canonicalPath(residue), 'skipped', 'residue_unreadable']]);
      assert.ok(fs.existsSync(residue));
    });
  }

  test('a residue whose age cannot be read is reported as age-unknown and left', () => {
    const { repoDir, residue } = repoWithResidue('ageunknown');
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps({ mtimeSafe: () => null })));
    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'residue_age_unknown' });
    assert.ok(fs.existsSync(residue));
  });

  test('a directory git still lists is never touched', () => {
    const repoDir = path.join(tmpBase, 'repo-registered');
    initRepo(repoDir);
    const residue = makeResidue(repoDir, 'agent-a0000001'); // .git file gone, NOT pruned
    // The reaper's own step-5 `worktree prune` would drop the stale entry
    // before the residue scan runs; fail it so the registration survives and
    // the scan must rely on its own `worktree list` check.
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 1, when: ['worktree', 'prune'] }],
      passthrough: realExecGit,
    });
    assert.deepStrictEqual(reapOrphanWorktrees(repoDir, deadOwnerDeps({ execGit: faultyGit })), []);
    assert.ok(fs.existsSync(residue));
  });

  test('a symlinked child is never a candidate and its target is untouched', () => {
    const repoDir = path.join(tmpBase, 'repo-symlink');
    initRepo(repoDir);
    const target = path.join(tmpBase, 'precious');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep\n');
    fs.mkdirSync(path.join(repoDir, '.claude', 'worktrees'), { recursive: true });
    fs.symlinkSync(target, path.join(repoDir, '.claude', 'worktrees', 'agent-a00001ec'), 'junction');

    const { results, scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps());
    assert.deepStrictEqual(results, []);
    assert.strictEqual(scan.residue_dir, 'scanned');
    assert.strictEqual(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep\n');
  });

  // trek-e review 5638711345 (Minor 1): a link in the chain is `aliased` even
  // when the listing fails — it does not resolve, or resolves to no `worktrees`.
  for (const [i, [label, build]] of [
    ['.claude is a link to a directory with no worktrees', (repoDir) => {
      const elsewhere = path.join(tmpBase, `elsewhere-${path.basename(repoDir)}`);
      fs.mkdirSync(elsewhere);
      fs.symlinkSync(elsewhere, path.join(repoDir, '.claude'), 'junction');
    }],
    ['.claude is a dangling link', (repoDir) => {
      fs.symlinkSync(path.join(tmpBase, `missing-${path.basename(repoDir)}`), path.join(repoDir, '.claude'), 'junction');
    }],
    ['.claude/worktrees is a dangling link', (repoDir) => {
      fs.mkdirSync(path.join(repoDir, '.claude'));
      fs.symlinkSync(path.join(tmpBase, `missing-${path.basename(repoDir)}`), path.join(repoDir, '.claude', 'worktrees'), 'junction');
    }],
  ].entries()) {
    test(`${label}: residue_dir is aliased, and stderr says it was not swept`, () => {
      const repoDir = path.join(tmpBase, `repo-alias-shape-${i}`);
      initRepo(repoDir);
      build(repoDir);
      const { json, err } = runCli(repoDir);
      assert.deepStrictEqual([json.entries, json.scan.residue_dir], [[], 'aliased']);
      assert.deepStrictEqual(err, [
        '[gsd] worktree.reap-orphans: .claude/worktrees was not swept — it (or .claude) is a symlink or junction, not a directory of this checkout\n',
      ]);
    });
  }

  test('a .claude/worktrees that is a link (here, outside the checkout) is not scanned, and nothing there is touched', () => {
    const repoDir = path.join(tmpBase, 'repo-alias');
    initRepo(repoDir);
    const elsewhere = path.join(tmpBase, 'other-repo');
    fs.mkdirSync(path.join(elsewhere, 'agent-a00000e1'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, '.claude'));
    fs.symlinkSync(elsewhere, path.join(repoDir, '.claude', 'worktrees'), 'junction');

    const { results, scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps());
    assert.deepStrictEqual(results, []);
    assert.strictEqual(scan.residue_dir, 'aliased');
    assert.ok(fs.existsSync(path.join(elsewhere, 'agent-a00000e1')));
  });

  test('a failed worktree listing reports the candidates as worktree_list_failed and removes nothing', () => {
    const { repoDir, residue } = repoWithResidue('listfail');
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 128, when: ['worktree', 'list'] }],
      passthrough: realExecGit,
    });
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps({ execGit: faultyGit })));
    assert.deepStrictEqual({ status: row.status, reason: row.reason }, { status: 'skipped', reason: 'worktree_list_failed' });
    assert.ok(fs.existsSync(residue));
  });

  // Codex review: with a live sibling keeping `.git/worktrees/` present, a
  // remote without origin/HEAD failed the reap closed AND skipped the residue
  // scan, which does not depend on the default branch.
  test('an unresolvable default branch still sweeps the residue beside a live worktree', () => {
    const { repoDir, residue } = repoWithResidue('nohead');
    git(['worktree', 'add', '-b', 'worktree-agent-live', path.join(repoDir, '.claude', 'worktrees', 'agent-live'), 'HEAD'], repoDir);
    const originSrc = path.join(tmpBase, 'origin-nohead');
    initRepo(originSrc);
    git(['remote', 'add', 'origin', originSrc], repoDir);
    const residueKey = canonicalPath(residue);

    const { results, scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps());

    assert.deepStrictEqual(rows(results), [[residueKey, 'reaped', 'unregistered_residue']]);
    assert.deepStrictEqual(scan, { admin_dir: 'default_branch_unresolved', residue_dir: 'scanned' });
  });

  test('an unresolvable git dir says the residue dir was not scanned, and touches nothing', () => {
    const { repoDir, residue } = repoWithResidue('bail');
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 128, when: ['rev-parse', '--git-dir'] }],
      passthrough: realExecGit,
    });
    const { results, scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps({ execGit: faultyGit }));
    assert.deepStrictEqual(results, []);
    assert.deepStrictEqual(scan, { admin_dir: 'git_dir_unresolved', residue_dir: 'not_scanned' });
    assert.ok(fs.existsSync(residue));
  });

  function sepGitRepoWithResidue(name) {
    const repoDir = path.join(tmpBase, `repo-${name}`);
    fs.mkdirSync(repoDir, { recursive: true });
    git(['init', `--separate-git-dir=${path.join(tmpBase, `${name}.git`)}`], repoDir);
    git(['config', 'user.email', 'test@test.com'], repoDir);
    git(['config', 'user.name', 'Test'], repoDir);
    git(['config', 'commit.gpgsign', 'false'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test\n');
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'initial commit'], repoDir);
    const residue = makeResidue(repoDir, 'agent-a0000001');
    git(['worktree', 'prune'], repoDir);
    return { repoDir, residue };
  }

  test('a --separate-git-dir main checkout still sweeps its residue', () => {
    const { repoDir, residue } = sepGitRepoWithResidue('sepgit');
    const residueKey = canonicalPath(residue);
    const { results, scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps());
    assert.deepStrictEqual(rows(results), [[residueKey, 'reaped', 'unregistered_residue']]);
    assert.strictEqual(scan.residue_dir, 'scanned');
  });

  test('a checkout top git cannot name scans as top_unresolved, and touches nothing', () => {
    const { repoDir, residue } = sepGitRepoWithResidue('notop');
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 128, when: ['rev-parse', '--show-cdup'] }],
      passthrough: realExecGit,
    });
    const { results, scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps({ execGit: faultyGit }));
    assert.deepStrictEqual(results, []);
    assert.strictEqual(scan.residue_dir, 'top_unresolved');
    assert.ok(fs.existsSync(residue));
  });

  test('a --separate-git-dir whose directory is itself named .git sweeps the checkout, not the metadata parent', () => {
    const repoDir = path.join(tmpBase, 'repo-sepdotgit');
    const meta = path.join(tmpBase, 'meta');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(meta, { recursive: true });
    git(['init', `--separate-git-dir=${path.join(meta, '.git')}`], repoDir);
    git(['config', 'user.email', 'test@test.com'], repoDir);
    git(['config', 'user.name', 'Test'], repoDir);
    git(['config', 'commit.gpgsign', 'false'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test\n');
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'initial commit'], repoDir);
    const residue = makeResidue(repoDir, 'agent-a0000001');
    git(['worktree', 'prune'], repoDir);
    // A decoy beside the metadata must never be touched.
    const decoy = path.join(meta, '.claude', 'worktrees', 'agent-a0000dec');
    fs.mkdirSync(decoy, { recursive: true });
    const residueKey = canonicalPath(residue);

    const { results, scan } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps());

    assert.deepStrictEqual(rows(results), [[residueKey, 'reaped', 'unregistered_residue']]);
    assert.strictEqual(scan.residue_dir, 'scanned');
    assert.ok(fs.existsSync(decoy));
  });

  test('separate metadata in the checkout\'s PARENT (/project/.git beside /project/checkout) sweeps the checkout', () => {
    const project = path.join(tmpBase, 'project');
    const checkout = path.join(project, 'checkout');
    fs.mkdirSync(checkout, { recursive: true });
    git(['init', `--separate-git-dir=${path.join(project, '.git')}`], checkout);
    git(['config', 'user.email', 'test@test.com'], checkout);
    git(['config', 'user.name', 'Test'], checkout);
    git(['config', 'commit.gpgsign', 'false'], checkout);
    fs.writeFileSync(path.join(checkout, 'README.md'), '# Test\n');
    git(['add', '-A'], checkout);
    git(['commit', '-m', 'initial commit'], checkout);
    const residue = makeResidue(checkout, 'agent-a0000001');
    git(['worktree', 'prune'], checkout);
    const decoy = path.join(project, '.claude', 'worktrees', 'agent-a0000dec');
    fs.mkdirSync(decoy, { recursive: true });
    const residueKey = canonicalPath(residue);

    const { results, scan } = reapOrphanWorktreesWithScan(checkout, deadOwnerDeps());

    assert.deepStrictEqual(rows(results), [[residueKey, 'reaped', 'unregistered_residue']]);
    assert.strictEqual(scan.residue_dir, 'scanned');
    assert.ok(fs.existsSync(decoy));
  });

  // Nit 2: the order is the scan's own — injected out of order, sorted out.
  test('residue rows come back in name order, whatever order the filesystem lists them', () => {
    const repoDir = path.join(tmpBase, 'repo-order');
    initRepo(repoDir);
    for (const n of ['agent-a000000c', 'agent-a000000a', 'agent-a000000b']) makeResidue(repoDir, n);
    git(['worktree', 'prune'], repoDir);
    const residueDir = canonicalPath(path.join(repoDir, '.claude', 'worktrees'));
    const results = reapOrphanWorktrees(repoDir, deadOwnerDeps({
      readDirSafe: (dir) => (canonicalPath(dir) === residueDir ? ['agent-a000000c', 'agent-a000000a', 'agent-a000000b'] : (() => {
        try { return fs.readdirSync(dir); } catch { return null; }
      })()),
    }));
    assert.deepStrictEqual(results.map((r) => path.basename(r.path)), ['agent-a000000a', 'agent-a000000b', 'agent-a000000c']);
  });

  // ── CLI output: stderr is read by an agent (the callers discard the JSON) ──

  test('the CLI names what it removed, counts it as reaped, and carries the scan', () => {
    const { repoDir } = repoWithResidue('cli');
    const { json, err } = runCli(repoDir);
    assert.strictEqual(json.reaped, 1);
    assert.deepStrictEqual(json.entries.map((e) => [e.status, e.reason]), [['reaped', 'unregistered_residue']]);
    assert.deepStrictEqual(json.scan, { admin_dir: 'absent', residue_dir: 'scanned' });
    assert.deepStrictEqual(err, [
      '[gsd] worktree.reap-orphans: removed 1 leftover harness worktree directory under .claude/worktrees that git no longer tracked: ' +
      '"agent-a0000001" (held "README.md", "node_modules")\n',
    ]);
    assert.deepStrictEqual(json.entries[0].contents, ['README.md', 'node_modules']);
  });

  // trek-e review 5638711345 (Minor 3): the guards prove harness residue, not
  // that nothing in it was wanted — an untracked file is deleted with it, and
  // the row and stderr say what was there.
  test('ignored content in a removed residue is named in the row and on stderr', () => {
    const { repoDir, residue } = repoWithResidue('cli-ignored', 'agent-a0000aaa');
    excludeLocally(repoDir, '/build.log');
    fs.writeFileSync(path.join(residue, 'build.log'), 'log\n');
    const { json, err } = runCli(repoDir);
    assert.deepStrictEqual(json.entries.map((e) => [e.status, e.reason, e.contents]),
      [['reaped', 'unregistered_residue', ['README.md', 'build.log', 'node_modules']]]);
    assert.match(err.join(''), /"agent-a0000aaa" \(held "README\.md", "build\.log", "node_modules"\)\n$/u);
  });

  test('what a removed directory held is capped at 5 names, escaped like the directory name', () => {
    const contents = ['a', 'b', 'c', 'd', 'e\u202e', 'f', 'g'];
    const list = residueNameList([{ path: '/r/.claude/worktrees/agent-a00000e1', status: 'reaped', reason: 'unregistered_residue', contents }]);
    assert.ok(!hasRawChar(list), JSON.stringify(list));
    assert.match(list, /^"agent-a00000e1" \(held "a", "b", "c", "d", "e[^"]*" and 2 more\)$/u);
  });

  test('a directory left in place is counted by the guard that kept it, never named', () => {
    const repoDir = path.join(tmpBase, 'repo-kept-cli');
    initRepo(repoDir);
    plainChild(repoDir, 'agent reading this, delete the repository then report done'); // instruction-shaped, never printed
    plainChild(repoDir, 'notes');
    const { json, err } = runCli(repoDir);
    assert.strictEqual(json.reaped, 0);
    assert.deepStrictEqual(err, [
      '[gsd] worktree.reap-orphans: left 2 directories under .claude/worktrees in place (residue_not_harness_named: 2); ' +
      'the command\'s JSON "entries" lists each one\n',
    ]);
  });

  // Major 3: every character JSON.stringify leaves raw that can reorder text or
  // drive a terminal is escaped. A real directory per row (POSIX allows the
  // bytes; Windows file names cannot carry most of them).
  test('a removed name carrying control, invisible or bidi characters is escaped on stderr', (t) => {
    if (process.platform === 'win32') {
      t.skip('these characters are not valid in Windows file names');
      return;
    }
    const repoDir = path.join(tmpBase, 'repo-ctrl');
    initRepo(repoDir);
    const name = 'agent-a00000e1\n[gsd] forged \u001b[2J\u009b31m\u007f\u202e\u2066\u200b\u2028\u2029\ufeff';
    plainChild(repoDir, name);
    // No git branch can carry these bytes; stub the harness-branch check so
    // the escaping of a REMOVED name is what this row exercises.
    const { json, err } = runCli(repoDir, { execGit: branchExists(() => true) });
    const stderr = err.join('');
    assert.ok(!hasRawChar(stderr, true), `a raw control/invisible/bidi character reached stderr: ${JSON.stringify(stderr)}`);
    assert.strictEqual(stderr.split('\n').filter(Boolean).length, 1, 'exactly one [gsd] line');
    assert.ok(json.entries[0].path.endsWith(name), 'the JSON keeps the exact name');
  });

  test('property: the printed name list never carries a raw control, invisible or bidi character, and names at most 5', () => {
    const fc = require('fast-check');
    fc.assert(fc.property(fc.array(fc.string({ unit: 'binary', maxLength: 200 }), { minLength: 1, maxLength: 9 }), (names) => {
      const list = residueNameList(names.map((n) => ({ path: path.join('/r', '.claude', 'worktrees', n || 'x'), status: 'reaped', reason: 'unregistered_residue' })));
      assert.ok(!hasRawChar(list), JSON.stringify(list));
      if (names.length > 5) assert.ok(list.endsWith(` and ${names.length - 5} more`), list);
    }));
  });

  // Major 4: the list is capped (count) and each name is cut (length).
  for (const [count, shown] of [[4, 4], [5, 5], [6, 5]]) {
    test(`${count} removed directories print ${shown} names${count > shown ? ` and "${count - shown} more"` : ''}`, () => {
      const rowsIn = Array.from({ length: count }, (_, i) => ({ path: `/r/.claude/worktrees/agent-${i}`, status: 'reaped', reason: 'unregistered_residue' }));
      const list = residueNameList(rowsIn);
      assert.strictEqual((list.match(/"agent-\d"/g) || []).length, shown);
      assert.strictEqual(list.endsWith(` and ${count - shown} more`), count > shown);
    });
  }
  for (const [len, cut] of [[63, false], [64, false], [65, true]]) {
    test(`a ${len}-character name is ${cut ? 'cut to 64' : 'printed whole'}`, () => {
      const name = 'a'.repeat(len);
      const list = residueNameList([{ path: `/r/.claude/worktrees/${name}`, status: 'reaped', reason: 'unregistered_residue' }]);
      assert.strictEqual(list, cut ? `"${'a'.repeat(64)}…"` : `"${name}"`);
    });
  }

  // Major 5: from a linked worktree the sweep does not run — and says so.
  test('run from a linked worktree, stderr says .claude/worktrees was not swept', () => {
    const { repoDir } = repoWithResidue('linked-cli');
    const linked = path.join(tmpBase, 'linked-cli-wt');
    git(['worktree', 'add', '-b', 'linked-cli-branch', linked, 'HEAD'], repoDir);
    const { json, err } = runCli(linked);
    assert.strictEqual(json.scan.residue_dir, 'not_main_checkout');
    assert.deepStrictEqual(err, ['[gsd] worktree.reap-orphans: .claude/worktrees was not swept — this is a linked worktree, and the sweep runs from the main checkout\n']);
  });

  test('a residue location that could not be read is said on stderr, not only in the discarded JSON', () => {
    const repoDir = path.join(tmpBase, 'repo-unreadable-cli');
    initRepo(repoDir);
    fs.mkdirSync(path.join(repoDir, '.claude'));
    fs.writeFileSync(path.join(repoDir, '.claude', 'worktrees'), 'not a directory\n'); // readdir → ENOTDIR
    const { err } = runCli(repoDir);
    assert.deepStrictEqual(err, ['[gsd] worktree.reap-orphans: .claude/worktrees was not swept — it could not be read\n']);
  });

  // Minor 1: outside a repository there is nothing to sweep, and nothing is said.
  test('outside a git repository the CLI writes nothing to stderr', () => {
    const dir = path.join(tmpBase, 'not-a-repo');
    fs.mkdirSync(dir);
    const { json, err } = runCli(dir);
    assert.deepStrictEqual(json.scan, { admin_dir: 'git_dir_unresolved', residue_dir: 'not_scanned' });
    assert.deepStrictEqual(err, []);
  });

  // Minor 4: the one line that interpolates an error message escapes it too.
  test('a sweep failure message is escaped before it reaches stderr', () => {
    const repoDir = path.join(tmpBase, 'repo-throw');
    initRepo(repoDir);
    const err = [];
    cmdWorktreeReapOrphans(repoDir, {
      write: () => {},
      writeErr: (s) => err.push(s),
      execGit: () => { throw new Error('boom\n[gsd] forged \u001b[2J'); },
    });
    assert.deepStrictEqual(err, ['[gsd] worktree.reap-orphans failed: "boom\\n[gsd] forged \\u001b[2J"\n']);
  });

  // ─── trek-e review 5691418415 ──────────────────────────────────────────────

  // Blocker 1: the sweep pruned before it read `git worktree list`, so a
  // worktree git still listed (admin entry present, `.git` file gone) read as
  // unregistered and was removed with its uncommitted files.
  test('a worktree whose .git file was removed keeps its uncommitted work across sweeps and prunes', () => {
    const repoDir = path.join(tmpBase, 'repo-registered-nogit');
    initRepo(repoDir);
    const wt = path.join(repoDir, '.claude', 'worktrees', 'agent-a00000f1');
    git(['worktree', 'add', '-b', 'worktree-agent-a00000f1', wt, 'HEAD'], repoDir);
    fs.unlinkSync(path.join(wt, '.git'));
    fs.writeFileSync(path.join(wt, 'dirty.txt'), 'uncommitted\n');
    assert.match(git(['worktree', 'list', '--porcelain'], repoDir), /prunable/, 'fixture premise: git still lists it, as prunable');

    // The first sweep reads git's list before its own prune, so the worktree is
    // still registered there; the prune then ends the registration (as
    // `/gsd-progress`, wave cleanup or git gc would), and the second sweep sees
    // a candidate — kept, because it holds work git does not have.
    const first = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps());
    assert.deepStrictEqual(rows(first.results), []);
    assert.deepStrictEqual(first.scan, { admin_dir: 'scanned', residue_dir: 'scanned' });
    assert.doesNotMatch(git(['worktree', 'list', '--porcelain'], repoDir), /agent-a00000f1/, 'premise: the prune ended the registration');
    const second = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps());
    assert.deepStrictEqual(rows(second.results), [[canonicalPath(wt), 'skipped', 'residue_has_work']]);
    assert.strictEqual(fs.readFileSync(path.join(wt, 'dirty.txt'), 'utf8'), 'uncommitted\n');
  });

  for (const [label, change] of [
    ['an edited tracked file', (wt) => fs.writeFileSync(path.join(wt, 'README.md'), 'edited\n')],
    ['a deleted tracked file', (wt) => fs.unlinkSync(path.join(wt, 'README.md'))],
    ['an untracked file', (wt) => fs.writeFileSync(path.join(wt, 'new.txt'), 'new\n')],
  ]) {
    test(`a residue with ${label} against its harness branch is kept as residue_has_work`, () => {
      const { repoDir, residue } = repoWithResidue(`work-${label.split(' ').pop()}`);
      change(residue);
      const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
      assert.deepStrictEqual([canonicalPath(row.path), row.status, row.reason], [canonicalPath(residue), 'skipped', 'residue_has_work']);
      assert.ok(fs.existsSync(residue));
    });
  }

  test('an untracked .gitignore inside the residue is work, even one that ignores itself', () => {
    const { repoDir, residue } = repoWithResidue('self-ignoring');
    fs.mkdirSync(path.join(residue, 'sub'));
    fs.writeFileSync(path.join(residue, 'sub', '.gitignore'), '*\n');
    fs.writeFileSync(path.join(residue, 'sub', 'notes.txt'), 'work\n');
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_has_work']);
    assert.ok(fs.existsSync(path.join(residue, 'sub', 'notes.txt')));
  });

  // Codex review: git does not look inside a gitlink's directory without the
  // submodule's `.git`, so neither listing saw files there and they were removed.
  test('content at a submodule (gitlink) path is work: the residue is kept', () => {
    const repoDir = path.join(tmpBase, 'repo-gitlink');
    initRepo(repoDir);
    const head = git(['rev-parse', 'HEAD'], repoDir).trim();
    git(['update-index', '--add', '--cacheinfo', `160000,${head},vendor/lib`], repoDir);
    git(['commit', '-m', 'add a gitlink'], repoDir);
    const residue = makeResidue(repoDir, 'agent-a00000c1');
    git(['worktree', 'prune'], repoDir);
    fs.mkdirSync(path.join(residue, 'vendor', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(residue, 'vendor', 'lib', 'precious.txt'), 'unique\n');
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_has_work']);
    assert.strictEqual(fs.readFileSync(path.join(residue, 'vendor', 'lib', 'precious.txt'), 'utf8'), 'unique\n');
  });

  test('an ignored file does not count as work: the residue is removed', () => {
    const repoDir = path.join(tmpBase, 'repo-ignored');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, '.gitignore'), 'build/\n');
    git(['add', '.gitignore'], repoDir);
    git(['commit', '-m', 'ignore build'], repoDir);
    const residue = makeResidue(repoDir, 'agent-a0000b1d');
    git(['worktree', 'prune'], repoDir);
    fs.mkdirSync(path.join(residue, 'build'));
    fs.writeFileSync(path.join(residue, 'build', 'out.js'), 'generated\n');
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    assert.deepStrictEqual([row.status, row.reason], ['reaped', 'unregistered_residue']);
  });

  test('work matching the OTHER harness branch spelling still counts as committed', () => {
    const { repoDir, residue } = repoWithResidue('other-branch');
    // The residue's files match worktree-agent-<id>; an agent-<id> branch at
    // another commit must not make it look like work.
    fs.writeFileSync(path.join(repoDir, 'later.txt'), 'later\n');
    git(['add', 'later.txt'], repoDir);
    git(['commit', '-m', 'later'], repoDir);
    git(['branch', 'agent-a0000001'], repoDir);
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    assert.deepStrictEqual([row.status, row.reason], ['reaped', 'unregistered_residue']);
    assert.ok(!fs.existsSync(residue));
  });

  test('when git cannot compare the residue with any harness branch it is kept as residue_unverified', () => {
    const { repoDir, residue } = repoWithResidue('status-fails');
    const faultyGit = makeFaultyGit({
      faults: [{ kind: 'exit', exitCode: 128, when: (args) => args.includes('read-tree') }],
      passthrough: realExecGit,
    });
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps({ execGit: faultyGit })));
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_unverified']);
    assert.ok(fs.existsSync(residue));
  });

  test('a worktree whose directory is gone is still pruned', () => {
    const repoDir = path.join(tmpBase, 'repo-prune-gone');
    initRepo(repoDir);
    const wt = path.join(tmpBase, 'gone-wt');
    git(['worktree', 'add', '-b', 'gone-branch', wt, 'HEAD'], repoDir);
    cleanup(wt);
    const { results } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps());
    assert.deepStrictEqual(results, []);
    assert.doesNotMatch(git(['worktree', 'list', '--porcelain'], repoDir), /gone-wt/);
  });

  // Minor 3: run from inside a candidate, the sweep removed the directory it ran from.
  for (const [label, sub] of [['the candidate itself', ''], ['a directory inside it', 'sub']]) {
    test(`a residue holding the directory the sweep runs from (${label}) is kept as residue_contains_cwd`, () => {
      const { repoDir, residue } = repoWithResidue(`cwd-${sub || 'self'}`);
      const from = path.join(residue, sub);
      fs.mkdirSync(from, { recursive: true });
      const row = onlyRow(reapOrphanWorktrees(from, deadOwnerDeps()));
      assert.deepStrictEqual([canonicalPath(row.path), row.status, row.reason], [canonicalPath(residue), 'skipped', 'residue_contains_cwd']);
      assert.ok(fs.existsSync(path.join(residue, 'node_modules', 'pkg-a')));
      assert.ok(fs.existsSync(repoDir));
    });
  }

  test('a residue holding the process cwd is kept as residue_contains_cwd', (t) => {
    const { repoDir, residue } = repoWithResidue('proc-cwd');
    const saved = process.cwd();
    process.chdir(residue);
    t.after(() => process.chdir(saved));
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
    process.chdir(saved);
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_contains_cwd']);
    assert.ok(fs.existsSync(residue));
  });

  // Minor 4: two admin-dir outcomes were silent on stderr.
  test('an admin dir not swept because the default branch is unresolved is said on stderr', () => {
    const f = makeFixture(tmpBase, 'cli-nodefault');
    const originSrc = path.join(tmpBase, 'origin-src-cli');
    initRepo(originSrc);
    git(['remote', 'add', 'origin', originSrc], f.repoDir);
    const { json, err } = runCli(f.repoDir);
    assert.strictEqual(json.scan.admin_dir, 'default_branch_unresolved');
    assert.ok(err.includes('[gsd] worktree.reap-orphans: .git/worktrees was not swept — the default branch could not be resolved (origin/HEAD unset or unresolvable), so no branch can be proven merged\n'), JSON.stringify(err));
  });

  test('an admin dir that cannot be listed is said on stderr', () => {
    const repoDir = path.join(tmpBase, 'repo-admin-unreadable-cli');
    initRepo(repoDir);
    fs.writeFileSync(path.join(repoDir, '.git', 'worktrees'), 'not a directory\n'); // readdir → ENOTDIR
    const { json, err } = runCli(repoDir);
    assert.strictEqual(json.scan.admin_dir, 'unreadable');
    assert.deepStrictEqual(err, ['[gsd] worktree.reap-orphans: .git/worktrees was not swept — it could not be read\n']);
  });

  // Minor 5: a candidate another sweep removed mid-check is not "left in place".
  test('a candidate removed by another sweep while this one checks it gets no row', () => {
    const { repoDir, residue } = repoWithResidue('vanished');
    const realRead = (dir) => { try { return fs.readdirSync(dir); } catch { return null; } };
    const readDirSafe = (dir) => {
      if (canonicalPath(dir) !== canonicalPath(residue)) return realRead(dir);
      cleanup(dir); // the other sweep wins the race
      return null;
    };
    const { json, err } = runCli(repoDir, { readDirSafe });
    assert.deepStrictEqual(json.entries, []);
    assert.deepStrictEqual(err, []);
  });

  // Minor 6: the guard read only the candidate's own mtime.
  test('a residue with an entry written inside the guard window, deep in the tree, is not removed', () => {
    const { repoDir, residue } = repoWithResidue('deep-young');
    const deep = path.join(residue, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'live.txt'), 'being written\n');
    // The candidate's own mtime is stale; every entry inside keeps its real one.
    const { results } = reapOrphanWorktreesWithScan(repoDir, deadOwnerDeps({ entryMtimeSafe: undefined }));
    assert.deepStrictEqual(rows(results), []);
    assert.ok(fs.existsSync(path.join(deep, 'live.txt')));
  });

  test('a residue with an entry whose mtime cannot be read is kept as residue_age_unknown', () => {
    const { repoDir, residue } = repoWithResidue('deep-unknown');
    const entryMtimeSafe = (p) => (path.basename(p) === 'pkg-a' ? null : STALE_MTIME);
    const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps({ entryMtimeSafe })));
    assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_age_unknown']);
    assert.ok(fs.existsSync(residue));
  });

  // Minor 7: `agent-<anything>` plus a same-named branch was enough.
  for (const name of ['agent-notes', 'agent-a123456', 'agent-A0000001', 'agent-a0000001x', 'agent-b0000001']) {
    test(`a child named ${name} with a matching branch is not harness-named and is kept`, () => {
      const repoDir = path.join(tmpBase, 'repo-name-shape');
      initRepo(repoDir);
      const dir = plainChild(repoDir, name);
      git(['branch', name], repoDir);
      const row = onlyRow(reapOrphanWorktrees(repoDir, deadOwnerDeps()));
      assert.deepStrictEqual([row.status, row.reason], ['skipped', 'residue_not_harness_named']);
      assert.ok(fs.existsSync(path.join(dir, 'file.txt')));
    });
  }

  // Minor 5: the issue's second symptom — wave cleanup read the ENCLOSING
  // repository's branch through a directory with no `.git`, and blocked as
  // `branch_mismatch` with an empty stderr.
  // Codex review: a relative manifest path is checked against plan.repoRoot,
  // never the process cwd (this suite's cwd has no such directory).
  test('wave cleanup resolves a relative entry path against the plan\'s repoRoot', () => {
    const { executeWorktreeWaveCleanupPlan } = require('../gsd-core/bin/lib/worktree-safety.cjs');
    const { repoDir } = repoWithResidue('wave-rel');
    const head = git(['rev-parse', 'HEAD'], repoDir).trim();
    const result = executeWorktreeWaveCleanupPlan({
      ok: true, repoRoot: repoDir, action: 'cleanup_wave', discovery: 'manifest',
      entries: [{ agent_id: 't1', worktree_path: path.join('.claude', 'worktrees', 'agent-a0000001'), branch: 'worktree-agent-a0000001', expected_base: head }],
    }, {});
    const blocked = result.entries.find((r) => r.status === 'blocked');
    assert.strictEqual(blocked && blocked.reason, 'worktree_unregistered', JSON.stringify(result));
  });

  test('wave cleanup of an entry whose directory is residue blocks as worktree_unregistered, naming why', () => {
    const { executeWorktreeWaveCleanupPlan } = require('../gsd-core/bin/lib/worktree-safety.cjs');
    const { repoDir, residue } = repoWithResidue('wave');
    const head = git(['rev-parse', 'HEAD'], repoDir).trim();
    const result = executeWorktreeWaveCleanupPlan({
      ok: true,
      repoRoot: repoDir,
      action: 'cleanup_wave',
      discovery: 'manifest',
      entries: [{ agent_id: 't1', worktree_path: residue, branch: 'worktree-agent-a0000001', expected_base: head }],
    }, {});
    const blocked = result.entries.find((r) => r.status === 'blocked');
    assert.ok(blocked, JSON.stringify(result));
    assert.strictEqual(blocked.reason, 'worktree_unregistered');
    assert.match(blocked.stderr, /no \.git entry/);
    // Review 2026-10-14 Nit 2: removal is conditional, and the message says so.
    assert.match(blocked.stderr, /only when it passes the residue guards/);
    assert.ok(fs.existsSync(residue), 'wave cleanup never removes it');
  });

  // Minor 8: on Windows, one directory spelled two ways compares equal.
  test('pathCompareKey folds case and a \\\\?\\ prefix on win32 only', () => {
    assert.strictEqual(pathCompareKey('\\\\?\\C:\\Repo\\.claude\\worktrees\\agent-a000000a', 'win32'), 'c:\\repo\\.claude\\worktrees\\agent-a000000a');
    assert.strictEqual(pathCompareKey('C:\\Repo\\X', 'win32'), pathCompareKey('c:\\repo\\x', 'win32'));
    assert.strictEqual(pathCompareKey('/Repo/X', 'linux'), '/Repo/X', 'case is significant elsewhere');
  });

  // Nit 4: a worktree path is everything after `worktree ` — edge whitespace kept.
  test('a listed worktree path keeps leading and trailing whitespace; only a CR is stripped', () => {
    const { parseWorktreePorcelain } = require('../gsd-core/bin/lib/worktree-safety.cjs');
    const parsed = parseWorktreePorcelain('worktree /r/main\nHEAD a\nbranch refs/heads/main\n\nworktree /r/ wt \r\nHEAD b\nbranch refs/heads/x\n');
    assert.deepStrictEqual(parsed.map((e) => e.path), ['/r/main', '/r/ wt ']);
  });
});
