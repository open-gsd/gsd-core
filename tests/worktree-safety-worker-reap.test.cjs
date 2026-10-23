'use strict';

/**
 * worktree-safety — in-process verdict rows for the orphan reaper, the worker
 * lifecycle records, git C-quoted path decoding, and the worktree
 * list / inventory / prune seams (#5232 mutation-score work).
 *
 * Seam: gsd-core/bin/lib/worktree-safety.cjs
 * Interface: reapOrphanWorktrees, cmdWorktreeReapOrphans, cmdWorktreeWorkerRecord,
 *   cmdWorktreeWorkerStatus, cmdWorktreeWorkerComplete, decodeGitQuotedPath,
 *   resolveWorktreeLinkage, listLinkedWorktreePaths, snapshotWorktreeInventory,
 *   inspectWorktreeHealth, executeWorktreePrunePlan, pruneOrphanedWorktrees,
 *   parseWorktreePorcelain
 *
 * WHY THIS FILE EXISTS
 * scripts/mutation-matrix.cjs derives the worktree-safety mutation shard from
 * test files named after the module, so tests/worktree-worker-log.test.cjs
 * (the #4624 worker-record rows) never ran against these mutants, and the
 * reaper rows in worktree-safety-reap.test.cjs drive real git, which leaves
 * the default-branch discovery order, the listed-path spelling lookup and the
 * exact argv of every git call unpinned. Every row below injects the `deps`
 * seams (execGit, readDirSafe/readFileSafe/mtimeSafe, isPidAlive, existsSync,
 * statSync, write/writeErr, fs.renameSync via t.mock) and asserts the specific
 * documented verdict, reason code, path or seam call — each paired, where it
 * matters, with the near-miss that must answer the other way.
 *
 * Determinism: no wall clock (nowMs/mtime injected; the rename back-off spin
 * runs against a mocked Date.now), no live PID probe (isPidAlive injected),
 * and no git subprocess — git is a scripted fake throughout.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { makeFaultyGit } = require('./helpers/faulty-deps.cjs');

const {
  reapOrphanWorktrees,
  cmdWorktreeReapOrphans,
  cmdWorktreeWorkerRecord,
  cmdWorktreeWorkerStatus,
  cmdWorktreeWorkerComplete,
  decodeGitQuotedPath,
  resolveWorktreeLinkage,
  listLinkedWorktreePaths,
  snapshotWorktreeInventory,
  inspectWorktreeHealth,
  executeWorktreePrunePlan,
  pruneOrphanedWorktrees,
  parseWorktreePorcelain,
} = require('../gsd-core/bin/lib/worktree-safety.cjs');

// ─── Shared fakes ────────────────────────────────────────────────────────────

function ok(stdout = '') {
  return { exitCode: 0, stdout, stderr: '', signal: null, error: null, timedOut: false };
}

function fail(exitCode = 1, stderr = '') {
  return { exitCode, stdout: '', stderr, signal: null, error: null, timedOut: false };
}

function timedOut() {
  return { exitCode: 1, stdout: '', stderr: '', signal: 'SIGTERM', error: null, timedOut: true };
}

/**
 * An execGit fake answering from an argv-string table (`args.join(' ')`).
 * Unlisted argv exits 1, so a call the row did not anticipate can never read
 * as success. Calls are recorded by makeFaultyGit.
 */
function scriptedGit(table) {
  return makeFaultyGit({
    passthrough: (args) => {
      const key = args.join(' ');
      if (!Object.prototype.hasOwnProperty.call(table, key)) return fail(1);
      const v = table[key];
      return typeof v === 'function' ? v(args) : v;
    },
  });
}

function argv(git) {
  return git.calls.map((c) => c.args.join(' '));
}

// ─── reapOrphanWorktrees ─────────────────────────────────────────────────────

const MAIN_SHA = 'a'.repeat(40);
const BRANCH_SHA = 'b'.repeat(40);
const NOW = 10_000_000_000;
const STALE_LOCK = new Date(NOW - 60 * 60 * 1000);

describe('reapOrphanWorktrees: default-branch discovery, listed-path lookup, git argv', () => {
  let repoRoot;
  let wtDir;
  let adminDir;

  beforeEach(() => {
    repoRoot = createTempDir('gsd-reap5232-repo-');
    wtDir = createTempDir('gsd-reap5232-wt-');
    adminDir = path.join(repoRoot, '.git', 'worktrees', 'wt1');
  });

  afterEach(() => {
    cleanup(repoRoot);
    cleanup(wtDir);
  });

  /** git table for a local-only repo whose HEAD is `main`, with one locked linked worktree. */
  function localRepoTable(overrides = {}) {
    return {
      'rev-parse --git-dir': ok('.git\n'),
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD': fail(1),
      remote: ok(''),
      'config --get init.defaultBranch': fail(1),
      'symbolic-ref --quiet --short HEAD': ok('main\n'),
      'rev-parse main': ok(`${MAIN_SHA}\n`),
      'worktree list --porcelain': ok(`worktree ${repoRoot}\nHEAD ${MAIN_SHA}\nbranch refs/heads/main\n\n`),
      'rev-parse refs/heads/agent-1': ok(`${BRANCH_SHA}\n`),
      [`merge-base --is-ancestor ${BRANCH_SHA} ${MAIN_SHA}`]: ok(''),
      [`worktree unlock ${wtDir}`]: ok(''),
      [`worktree remove ${wtDir} --force`]: ok(''),
      'worktree prune': ok(''),
      ...overrides,
    };
  }

  function adminFiles(overrides = {}) {
    return {
      [path.join(adminDir, 'locked')]: '4242\n',
      [path.join(adminDir, 'gitdir')]: `${path.join(wtDir, '.git')}\n`,
      [path.join(adminDir, 'HEAD')]: 'ref: refs/heads/agent-1\n',
      ...overrides,
    };
  }

  function reap(git, { files = adminFiles(), isPidAlive = () => false } = {}) {
    return reapOrphanWorktrees(repoRoot, {
      execGit: git,
      readDirSafe: (dir) => (dir === path.join(repoRoot, '.git', 'worktrees') ? ['wt1'] : null),
      readFileSafe: (file) => (Object.prototype.hasOwnProperty.call(files, file) ? files[file] : null),
      mtimeSafe: () => STALE_LOCK,
      isPidAlive,
      nowMs: NOW,
    });
  }

  function revParseCandidates(git) {
    return git.calls
      .filter((c) => c.args[0] === 'rev-parse' && c.args.length === 2 && !c.args[1].startsWith('-') && !c.args[1].startsWith('refs/'))
      .map((c) => c.args[1]);
  }

  test('a known origin/HEAD is used exclusively, every git call runs at repoRoot, and prune always runs last', () => {
    const git = scriptedGit(localRepoTable({
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD': ok('origin/trunk\n'),
      'rev-parse refs/remotes/origin/trunk': ok(`${MAIN_SHA}\n`),
    }));
    const results = reap(git);
    assert.deepEqual(results, [{ path: wtDir, status: 'reaped', reason: 'pid_dead_and_merged' }]);
    assert.deepEqual(argv(git), [
      'rev-parse --git-dir',
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD',
      'rev-parse refs/remotes/origin/trunk',
      'worktree list --porcelain',
      'rev-parse refs/heads/agent-1',
      `merge-base --is-ancestor ${BRANCH_SHA} ${MAIN_SHA}`,
      `worktree unlock ${wtDir}`,
      `worktree remove ${wtDir} --force`,
      'worktree prune',
    ], 'remote default known: no local candidate probing, and `worktree prune` closes the sweep');
    for (const c of git.calls) {
      assert.equal(c.opts.cwd, repoRoot, `git ${c.args.join(' ')} must run in the repo being reaped`);
    }
  });

  test('no remote: candidates are init.defaultBranch, then the HEAD symref, then main, then master — first that resolves wins', () => {
    const git = scriptedGit(localRepoTable({
      // Whitespace-only `git remote` output means "no remote" — the sweep must
      // not fail closed on it as it does for a real remote without origin/HEAD.
      remote: ok('\n'),
      'config --get init.defaultBranch': ok('trunk\n'),
      'symbolic-ref --quiet --short HEAD': ok('dev\n'),
      'rev-parse main': ok(`${MAIN_SHA}\n`),
    }));
    const results = reap(git);
    assert.deepEqual(revParseCandidates(git), ['trunk', 'dev', 'main'],
      'config first, HEAD second, then the main fallback; stops at the first that resolves');
    assert.ok(argv(git).includes(`merge-base --is-ancestor ${BRANCH_SHA} ${MAIN_SHA}`),
      'ancestry is judged against the resolved candidate tip');
    assert.equal(results[0].status, 'reaped');
    for (const c of git.calls) {
      assert.equal(c.opts.cwd, repoRoot, `git ${c.args.join(' ')} must read the reaped repo's config/HEAD, not the caller's`);
    }
  });

  test('a HEAD symref equal to init.defaultBranch is probed once, and main/master are not re-added', () => {
    const git = scriptedGit(localRepoTable({
      'config --get init.defaultBranch': ok('main\n'),
      'symbolic-ref --quiet --short HEAD': ok('main\n'),
      'rev-parse main': fail(128),
      'rev-parse master': ok(`${MAIN_SHA}\n`),
    }));
    reap(git);
    assert.deepEqual(revParseCandidates(git), ['main', 'master'],
      'a duplicate candidate would re-probe a ref already known not to resolve');
  });

  test('blank init.defaultBranch and blank HEAD output contribute no candidate', () => {
    const git = scriptedGit(localRepoTable({
      'config --get init.defaultBranch': ok('  \n'),
      'symbolic-ref --quiet --short HEAD': ok('\n'),
      'rev-parse main': fail(128),
      'rev-parse master': ok(`${MAIN_SHA}\n`),
    }));
    const results = reap(git);
    assert.deepEqual(revParseCandidates(git), ['main', 'master'],
      'an empty name must never become a `git rev-parse ""` probe');
    assert.equal(results[0].status, 'reaped');
  });

  test('a failed config / detached HEAD contributes no candidate either', () => {
    const git = scriptedGit(localRepoTable({
      'symbolic-ref --quiet --short HEAD': fail(1),
    }));
    reap(git);
    assert.deepEqual(revParseCandidates(git), ['main']);
  });

  test('git is told the path it LISTED, not the gitdir-derived spelling of the same directory', () => {
    // `wtDir/.` names the same directory as `wtDir` but is spelled differently —
    // the stand-in for git listing a canonical path (e.g. /private/var vs /var)
    // while the admin `gitdir` pointer carries another spelling. The worktree is
    // the SECOND block of CRLF output, so block splitting must survive CRLF, and
    // trailing whitespace on the worktree line is not part of the path.
    const listedSpelling = `${wtDir}${path.sep}.`;
    const git = scriptedGit(localRepoTable({
      'worktree list --porcelain': ok(
        `worktree ${repoRoot}\r\nHEAD ${MAIN_SHA}\r\nbranch refs/heads/main\r\n\r\n` +
        `worktree ${listedSpelling} \r\nHEAD ${BRANCH_SHA}\r\nlocked\r\n\r\n`,
      ),
      [`worktree unlock ${listedSpelling}`]: ok(''),
      [`worktree remove ${listedSpelling} --force`]: ok(''),
    }));
    const results = reap(git);
    assert.deepEqual(results, [{ path: listedSpelling, status: 'reaped', reason: 'pid_dead_and_merged' }]);
    assert.ok(argv(git).includes(`worktree remove ${listedSpelling} --force`));
  });

  test('near-miss: when `git worktree list` fails, the gitdir-derived path is used as-is', () => {
    const git = scriptedGit(localRepoTable({ 'worktree list --porcelain': fail(128) }));
    const results = reap(git);
    assert.deepEqual(results, [{ path: wtDir, status: 'reaped', reason: 'pid_dead_and_merged' }]);
  });

  test('a lock reason with surrounding whitespace still names its owner PID', () => {
    const probed = [];
    const git = scriptedGit(localRepoTable());
    const results = reap(git, {
      files: adminFiles({ [path.join(adminDir, 'locked')]: '\n  4242 claude agent\n' }),
      isPidAlive: (pid) => { probed.push(pid); return false; },
    });
    assert.deepEqual(probed, [4242]);
    assert.equal(results[0].status, 'reaped');
  });

  test('a detached HEAD must be exactly 40 hex digits; 41 digits fails closed before any ancestry check', () => {
    const git = scriptedGit(localRepoTable());
    const results = reap(git, { files: adminFiles({ [path.join(adminDir, 'HEAD')]: `${BRANCH_SHA}c\n` }) });
    assert.deepEqual(results, [{ path: wtDir, status: 'skipped', reason: 'cannot_resolve_branch_tip' }]);
    assert.ok(!argv(git).some((a) => a.startsWith('merge-base')), 'an unparseable tip must never reach the reap decision');
  });

  test('near-miss: an exact 40-hex detached HEAD is the tip that is ancestry-checked', () => {
    const git = scriptedGit(localRepoTable());
    const results = reap(git, { files: adminFiles({ [path.join(adminDir, 'HEAD')]: `${BRANCH_SHA}\n` }) });
    assert.equal(results[0].status, 'reaped');
    assert.ok(argv(git).includes(`merge-base --is-ancestor ${BRANCH_SHA} ${MAIN_SHA}`));
  });
});

describe('cmdWorktreeReapOrphans: a thrown sweep is a one-line warning, never a crash', () => {
  function runCmd(thrown) {
    let stdout = '';
    let stderr = '';
    cmdWorktreeReapOrphans('/repo', {
      execGit: () => { throw thrown; },
      write: (s) => { stdout += s; },
      writeErr: (s) => { stderr += s; },
    });
    return { stdout, stderr };
  }

  test('an Error is reported by its message, and the result is an empty successful sweep', () => {
    const r = runCmd(new Error('kaput'));
    assert.equal(r.stderr, '[gsd] worktree.reap-orphans failed: kaput\n');
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, reaped: 0, entries: [] });
  });

  test('a non-Error throw is stringified rather than reported as "undefined"', () => {
    const r = runCmd('boom');
    assert.equal(r.stderr, '[gsd] worktree.reap-orphans failed: boom\n');
  });
});

// ─── Worker lifecycle records (#4624) ───────────────────────────────────────

describe('worker-record / worker-status / worker-complete: in-process state machine', () => {
  let dir;
  let wtPath;
  let summaryPath;

  beforeEach(() => {
    dir = createTempDir('gsd-worker5232-');
    wtPath = path.join(dir, 'agent-p3');
    summaryPath = path.join(dir, '3-SUMMARY.md');
  });

  afterEach(() => {
    cleanup(dir);
  });

  function run(cmd, args, deps = {}) {
    let stdout = '';
    let stderr = '';
    const scoped = {
      write: (s) => { stdout += s; },
      writeErr: (s) => { stderr += s; },
      ...deps,
    };
    const prior = process.exitCode;
    process.exitCode = 0;
    if (cmd === 'record') cmdWorktreeWorkerRecord(dir, args, scoped);
    else if (cmd === 'status') cmdWorktreeWorkerStatus(dir, args, scoped);
    else cmdWorktreeWorkerComplete(dir, args, scoped);
    const exitCode = process.exitCode || 0;
    process.exitCode = prior;
    return { exitCode, stdout, stderr, json: stdout ? JSON.parse(stdout) : null };
  }

  const fullRecordArgs = () => ['--path', wtPath, '--pid', '4242', '--plan', '3', '--summary-path', summaryPath];
  const RECORD_USAGE = 'Usage: worktree worker-record --path <worktree> --pid <pid> --plan <plan_number> --summary-path <path> [--log-file <path>]\n';

  function writeRecord(record) {
    fs.writeFileSync(`${wtPath}.worker.json`, JSON.stringify(record));
  }

  // ── record ──

  for (const missing of ['--path', '--pid', '--plan', '--summary-path']) {
    test(`record without ${missing} is a usage error (exit 2) and writes nothing`, () => {
      const args = fullRecordArgs();
      args.splice(args.indexOf(missing), 2);
      const r = run('record', args);
      assert.equal(r.exitCode, 2);
      assert.equal(r.stderr, RECORD_USAGE);
      assert.equal(r.stdout, '');
      assert.equal(fs.existsSync(`${wtPath}.worker.json`), false);
    });
  }

  test('record rejects --pid 0 (no process has pid 0) with a named error', () => {
    const args = fullRecordArgs();
    args[args.indexOf('--pid') + 1] = '0';
    const r = run('record', args);
    assert.equal(r.exitCode, 2);
    assert.equal(r.stderr, '[gsd] worktree.worker-record: invalid --pid: 0\n');
    assert.equal(fs.existsSync(`${wtPath}.worker.json`), false);
  });

  test('near-miss: --pid 1 is the smallest valid pid and is recorded', () => {
    const args = fullRecordArgs();
    args[args.indexOf('--pid') + 1] = '1';
    const r = run('record', args);
    assert.equal(r.exitCode, 0);
    assert.equal(r.json.record.pid, 1);
  });

  test('record without --log-file stores an empty logFile and empty note; with it, the absolute log path', () => {
    const bare = run('record', fullRecordArgs());
    assert.equal(bare.json.record.logFile, '');
    assert.equal(bare.json.record.note, '');
    assert.equal(bare.json.record.exitCode, null);
    assert.equal(bare.json.record.completedAt, null);

    const other = path.join(dir, 'agent-p4');
    const withLog = run('record', ['--path', other, '--pid', '4243', '--plan', '4',
      '--summary-path', summaryPath, '--log-file', 'agent-p4.worker.log']);
    assert.equal(withLog.json.record.logFile, path.resolve(dir, 'agent-p4.worker.log'),
      'the log path resolves against cwd so a resumed session can read it from anywhere');
  });

  test('a record write failure is reported as write_failed (exit 1), never as a recorded launch', () => {
    const r = run('record', fullRecordArgs(), {
      writeFile: () => { throw new Error('disk full'); },
    });
    assert.equal(r.exitCode, 1);
    assert.equal(r.stderr, '[gsd] worktree.worker-record: write_failed — disk full\n');
    assert.deepEqual(r.json, { ok: false, reason: 'write_failed', error: 'disk full' });
  });

  // ── rename retry (Windows transient-lock errnos) ──

  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    test(`a transient ${code} on the record rename is retried, and the record lands`, (t) => {
      const realRename = fs.renameSync;
      let calls = 0;
      t.mock.method(fs, 'renameSync', (from, to) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error(code), { code });
        return realRename(from, to);
      });
      const r = run('record', fullRecordArgs());
      assert.equal(r.exitCode, 0, `${code} is a transient lock, not a failure`);
      assert.equal(calls, 2);
      assert.equal(JSON.parse(fs.readFileSync(`${wtPath}.worker.json`, 'utf8')).state, 'running');
    });
  }

  test('a non-transient rename error (ENOENT) fails on the first attempt, without retry', (t) => {
    let calls = 0;
    t.mock.method(fs, 'renameSync', () => {
      calls += 1;
      throw Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' });
    });
    const r = run('record', fullRecordArgs());
    assert.equal(calls, 1);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.reason, 'write_failed');
  });

  test('a persistent transient errno gives up after 4 attempts, backing off longer before each retry', (t) => {
    // Date.now is a fake that advances one tick per read, so the bounded spin
    // between attempts is counted deterministically rather than timed.
    let clock = 0;
    t.mock.method(Date, 'now', () => { clock += 1; return clock; });
    const attemptAt = [];
    t.mock.method(fs, 'renameSync', () => {
      attemptAt.push(clock);
      throw Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' });
    });
    const r = run('record', fullRecordArgs());
    assert.equal(attemptAt.length, 4);
    assert.equal(r.json.reason, 'write_failed');
    assert.equal(r.json.error, 'EBUSY: locked');
    for (let k = 1; k < attemptAt.length; k++) {
      const spinTicks = attemptAt[k] - attemptAt[k - 1];
      assert.ok(spinTicks >= 25 * k, `retry ${k} must wait at least ${25 * k} ticks (waited ${spinTicks})`);
    }
  });

  // ── status ──

  test('status with neither or both of --path/--root is a usage error on the injected stderr', () => {
    for (const args of [[], ['--path', wtPath, '--root', dir], ['--path']]) {
      const r = run('status', args);
      assert.equal(r.exitCode, 2, `args ${JSON.stringify(args)}`);
      assert.equal(r.stderr, 'Usage: worktree worker-status (--path <worktree> | --root <worktrees-dir>)\n');
    }
  });

  test('status --path with no record is found:false (never dispatched)', () => {
    const r = run('status', ['--path', wtPath]);
    assert.deepEqual(r.json, { ok: true, found: false, workers: [] });
  });

  test('status --path with a torn record is an unreadable reconciliation candidate, not "never dispatched"', () => {
    fs.writeFileSync(`${wtPath}.worker.json`, '{ truncated');
    const r = run('status', ['--path', wtPath]);
    assert.deepEqual(r.json, {
      ok: true,
      found: true,
      workers: [{ state: 'unreadable', needsReconciliation: true, recordPath: `${wtPath}.worker.json` }],
    });
  });

  test('a terminal record is never pid-probed and reports pidAlive:null, needsReconciliation:false', () => {
    writeRecord({ agentId: 'agent-p3', pid: 4242, plan: '3', worktreePath: wtPath, summaryPath,
      logFile: '', state: 'complete', exitCode: 0, note: '', startedAt: 'x', completedAt: 'y' });
    const probed = [];
    const r = run('status', ['--path', wtPath], { isPidAlive: (pid) => { probed.push(pid); return true; } });
    assert.deepEqual(probed, [], 'a finished worker\'s pid may be recycled; probing it means nothing');
    assert.equal(r.json.found, true);
    assert.equal(r.json.workers[0].pidAlive, null);
    assert.equal(r.json.workers[0].needsReconciliation, false);
  });

  test('status --root reads only *.worker.json, ignoring worktree dirs and other files', () => {
    run('record', fullRecordArgs());
    fs.mkdirSync(wtPath);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a record');
    const r = run('status', ['--root', dir], { isPidAlive: () => true });
    assert.equal(r.json.found, true);
    assert.deepEqual(r.json.workers.map((w) => [w.agentId, w.state, w.pidAlive]), [['agent-p3', 'running', true]]);
  });

  test('status --root on a missing directory lists no workers', () => {
    const r = run('status', ['--root', path.join(dir, 'never-created')]);
    assert.deepEqual(r.json, { ok: true, found: true, workers: [] });
  });

  // ── complete ──

  test('complete without --path or --exit-code is a usage error (exit 2) on the injected stderr', () => {
    const usage = 'Usage: worktree worker-complete --path <worktree> --exit-code <n> [--note <recovery info>]\n';
    for (const args of [['--exit-code', '0'], ['--path', wtPath], ['--path', wtPath, '--exit-code']]) {
      const r = run('complete', args);
      assert.equal(r.exitCode, 2, `args ${JSON.stringify(args)}`);
      assert.equal(r.stderr, usage);
    }
  });

  test('complete rejects a non-integer --exit-code', () => {
    const r = run('complete', ['--path', wtPath, '--exit-code', 'abc']);
    assert.equal(r.exitCode, 2);
    assert.equal(r.stderr, '[gsd] worktree.worker-complete: invalid --exit-code: abc\n');
  });

  test('complete with no record is no_record (exit 1)', () => {
    const r = run('complete', ['--path', wtPath, '--exit-code', '0']);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.reason, 'no_record');
    assert.match(r.stderr, /^\[gsd\] worktree\.worker-complete: no_record — /);
  });

  test('first completion stamps completedAt and keeps an empty note; it is not alreadyComplete', () => {
    run('record', fullRecordArgs());
    const r = run('complete', ['--path', wtPath, '--exit-code', '3']);
    assert.equal(r.exitCode, 0);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.alreadyComplete, false);
    assert.equal(r.json.record.state, 'complete');
    assert.equal(r.json.record.exitCode, 3);
    assert.equal(r.json.record.note, '');
    assert.match(r.json.record.completedAt, /^\d{4}-\d\d-\d\dT/);
  });

  test('re-completion is idempotent: keeps the original completedAt and note unless a new note is given', () => {
    writeRecord({ agentId: 'agent-p3', pid: 4242, plan: '3', worktreePath: wtPath, summaryPath, logFile: '',
      state: 'complete', exitCode: 0, note: 'recovered from log', startedAt: '2020-01-01T00:00:00.000Z',
      completedAt: '2020-01-01T01:00:00.000Z' });
    const again = run('complete', ['--path', wtPath, '--exit-code', '0']);
    assert.equal(again.json.alreadyComplete, true);
    assert.equal(again.json.record.completedAt, '2020-01-01T01:00:00.000Z');
    assert.equal(again.json.record.note, 'recovered from log', 'no --note must not erase recovery info');

    const renoted = run('complete', ['--path', wtPath, '--exit-code', '0', '--note', 'merged by hand']);
    assert.equal(renoted.json.record.note, 'merged by hand');
  });

  test('a completion write failure is write_failed (exit 1)', () => {
    run('record', fullRecordArgs());
    const r = run('complete', ['--path', wtPath, '--exit-code', '0'], {
      writeFile: () => { throw new Error('read-only fs'); },
    });
    assert.equal(r.exitCode, 1);
    assert.equal(r.stderr, '[gsd] worktree.worker-complete: write_failed — read-only fs\n');
    assert.deepEqual(r.json, { ok: false, reason: 'write_failed', error: 'read-only fs' });
  });
});

// ─── decodeGitQuotedPath ─────────────────────────────────────────────────────

describe('decodeGitQuotedPath: only a fully "-wrapped value is decoded', () => {
  const untouched = [
    ['"', 'a lone quote is too short to be a quoted form'],
    ['abc', 'plain ASCII'],
    ['abc"', 'trailing quote only'],
    ['"abc', 'leading quote only'],
  ];
  for (const [raw, why] of untouched) {
    test(`${JSON.stringify(raw)} is returned untouched (${why})`, () => {
      assert.equal(decodeGitQuotedPath(raw), raw);
    });
  }

  const decoded = [
    ['""', '', 'an empty quoted path'],
    ['"ab"', 'ab', 'plain body'],
    ['"\\303\\251t\\303\\251"', 'été', 'octal escapes are UTF-8 bytes decoded together'],
    ['"café"', 'café', 'a literal non-ASCII char inside quotes is kept as UTF-8'],
    ['"a\u{1F600}b"', 'a\u{1F600}b', 'a surrogate pair stays one character'],
    ['"a\\tb\\n\\"q\\"\\\\"', 'a\tb\n"q"\\', 'control and quote escapes'],
    ['"\\t123"', '\t123', 'digits after a control escape are not an octal escape'],
    ['"\\q"', 'q', 'an unknown escape degrades to the literal char'],
    ['"a\\"', 'a\\', 'a trailing lone backslash is literal and never throws'],
    ['"\\30x"', '30x', 'a short octal degrades to literal chars'],
  ];
  for (const [raw, want, why] of decoded) {
    test(`${JSON.stringify(raw)} decodes to ${JSON.stringify(want)} (${why})`, () => {
      assert.equal(decodeGitQuotedPath(raw), want);
    });
  }
});

// ─── list / linkage / inventory / health / prune ────────────────────────────

const PORCELAIN = [
  'worktree /repo\nHEAD 1111\nbranch refs/heads/main\n',
  'worktree /repo/wt-fresh  \nHEAD 2222\nbranch refs/heads/feat  \n',
  'worktree /repo/wt-old\nHEAD 3333\ndetached\n',
  'worktree \nHEAD 4444\n',
].join('\n');

function listGit(result) {
  return scriptedGit({ 'worktree list --porcelain': result });
}

describe('worktree list parsing and the list-failure reasons', () => {
  test('linked paths exclude the main worktree, trim trailing whitespace, and skip a path-less block', () => {
    assert.deepEqual(listLinkedWorktreePaths('/repo', { execGit: listGit(ok(PORCELAIN)) }), {
      ok: true,
      reason: 'ok',
      paths: ['/repo/wt-fresh', '/repo/wt-old'],
    });
  });

  test('parseWorktreePorcelain keeps branch-bearing entries with trimmed branch names', () => {
    assert.deepEqual(parseWorktreePorcelain(PORCELAIN), [
      { path: '/repo', branch: 'main' },
      { path: '/repo/wt-fresh', branch: 'feat' },
    ]);
  });

  test('a "not a git repository" failure is not_a_git_repo; any other failure is git_list_failed', () => {
    assert.deepEqual(
      listLinkedWorktreePaths('/x', { execGit: listGit(fail(128, 'fatal: not a git repository (or any parent)')) }),
      { ok: false, reason: 'not_a_git_repo', paths: [] },
    );
    assert.deepEqual(
      listLinkedWorktreePaths('/x', { execGit: listGit(fail(128, 'fatal: index file corrupt')) }),
      { ok: false, reason: 'git_list_failed', paths: [] },
    );
  });

  test('resolveWorktreeLinkage: EITHER rev-parse failing means not_git_repo, never a linked-worktree guess', () => {
    const cases = [
      { '--git-dir': fail(128), '--git-common-dir': ok('/main/.git\n') },
      { '--git-dir': ok('/main/.git/worktrees/x\n'), '--git-common-dir': fail(128) },
    ];
    for (const c of cases) {
      const git = scriptedGit({ 'rev-parse --git-dir': c['--git-dir'], 'rev-parse --git-common-dir': c['--git-common-dir'] });
      assert.deepEqual(resolveWorktreeLinkage('/cwd', { execGit: git }), {
        effectiveRoot: '/cwd',
        mode: 'current_directory',
        reason: 'not_git_repo',
      });
    }
  });
});

describe('snapshotWorktreeInventory / inspectWorktreeHealth: staleness against the default 1h bound', () => {
  const NOW_AT = 1_000_000_000;
  const MINUTE = 60 * 1000;
  const mtimes = { '/repo/wt-fresh': NOW_AT - 59 * MINUTE, '/repo/wt-old': NOW_AT - 61 * MINUTE };
  const fsDeps = () => ({
    execGit: listGit(ok(PORCELAIN)),
    existsSync: () => true,
    statSync: (p) => ({ mtimeMs: mtimes[p] }),
  });

  test('59 minutes old is present-not-stale; 61 minutes old is stale (default bound is one hour)', () => {
    assert.deepEqual(snapshotWorktreeInventory('/repo', { nowMs: NOW_AT }, fsDeps()), {
      ok: true,
      reason: 'ok',
      entries: [
        { path: '/repo/wt-fresh', exists: 'present', isStale: false, ageMinutes: 59 },
        { path: '/repo/wt-old', exists: 'present', isStale: true, ageMinutes: 61 },
      ],
    });
  });

  test('an age exactly equal to staleAfterMs is not yet stale', () => {
    const snap = snapshotWorktreeInventory('/repo', { nowMs: NOW_AT, staleAfterMs: 61 * MINUTE }, fsDeps());
    assert.deepEqual(snap.entries.map((e) => e.isStale), [false, false]);
  });

  test('a list failure is ok:false with no entries', () => {
    assert.deepEqual(snapshotWorktreeInventory('/repo', {}, { execGit: listGit(timedOut()) }),
      { ok: false, reason: 'git_timed_out', entries: [] });
  });

  test('health reports only the stale worktree, with its age', () => {
    assert.deepEqual(inspectWorktreeHealth('/repo', { nowMs: NOW_AT }, fsDeps()), {
      ok: true,
      reason: 'ok',
      findings: [{ kind: 'stale', path: '/repo/wt-old', ageMinutes: 61 }],
    });
  });
});

describe('executeWorktreePrunePlan / pruneOrphanedWorktrees: exact result shapes', () => {
  const plan = { repoRoot: '/repo', action: 'metadata_prune_only', reason: 'worktrees_present' };
  const pruneGit = (result) => scriptedGit({ 'worktree prune': result });

  test('an unsupported action is refused without running git', () => {
    const git = pruneGit(ok());
    assert.deepEqual(executeWorktreePrunePlan({ ...plan, action: 'remove_all' }, { execGit: git }),
      { ok: false, action: 'remove_all', reason: 'unsupported_action', pruned: [] });
    assert.deepEqual(git.calls, []);
  });

  test('a prune timeout is ok:false, git_timed_out, timedOut:true', () => {
    assert.deepEqual(executeWorktreePrunePlan(plan, { execGit: pruneGit(timedOut()) }),
      { ok: false, action: 'metadata_prune_only', reason: 'git_timed_out', timedOut: true, pruned: [] });
  });

  test('a failed prune is ok:false but keeps the plan reason and timedOut:false', () => {
    assert.deepEqual(executeWorktreePrunePlan(plan, { execGit: pruneGit(fail(1)) }),
      { ok: false, action: 'metadata_prune_only', reason: 'worktrees_present', timedOut: false, pruned: [] });
  });

  test('a clean prune is ok:true', () => {
    assert.deepEqual(executeWorktreePrunePlan(plan, { execGit: pruneGit(ok()) }),
      { ok: true, action: 'metadata_prune_only', reason: 'worktrees_present', timedOut: false, pruned: [] });
  });

  test('pruneOrphanedWorktrees warns only on a prune timeout, never on a clean prune', () => {
    const run = (pruneResult) => {
      const warnings = [];
      const out = pruneOrphanedWorktrees('/repo', {
        execGit: scriptedGit({ 'worktree list --porcelain': ok(PORCELAIN), 'worktree prune': pruneResult }),
        writeErr: (s) => warnings.push(s),
      });
      assert.deepEqual(out, []);
      return warnings;
    };
    assert.deepEqual(run(ok()), []);
    const warned = run(timedOut());
    assert.equal(warned.length, 1);
    assert.match(warned[0], /git worktree prune timed out/);
  });
});
