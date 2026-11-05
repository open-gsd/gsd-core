'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isReleaseVersion, versionFromPackageJson, applyVersion, syncViaPr, main, defaultRun } = require('../scripts/sync-next-version.cjs');

// ---------------------------------------------------------------------------
// Run-stub factory
// ---------------------------------------------------------------------------
/**
 * Creates a run stub for injection into applyVersion/syncViaPr/main.
 *
 * `responses` is an array of matchers:
 *   { cmd, args0, returns }   — if cmd matches and (args0 is set) args[0] matches → return `returns`
 *   { cmd, args0, throws }    — same match but throws the value
 *
 * Unmatched calls return '' by default.
 */
function makeRun(responses = []) {
  const calls = [];
  function run(cmd, args) {
    calls.push({ cmd, args: [...args] });
    for (const r of responses) {
      const cmdMatch = !r.cmd || r.cmd === cmd;
      const args0Match = r.args0 === undefined || r.args0 === args[0];
      const args1Match = r.args1 === undefined || r.args1 === args[1];
      if (cmdMatch && args0Match && args1Match) {
        if ('throws' in r) throw r.throws;
        return r.returns ?? '';
      }
    }
    return '';
  }
  run.calls = calls;
  return run;
}

// ---------------------------------------------------------------------------
// A. isReleaseVersion
// ---------------------------------------------------------------------------
test('isReleaseVersion — true for valid release versions', () => {
  for (const v of ['1.5.0', '1.5.0-rc.2', '1.5.0-beta.1', '10.20.30', '0.0.1', '1.5.0-rc.10']) {
    assert.equal(isReleaseVersion(v), true, `expected true for '${v}'`);
  }
});

test('isReleaseVersion — false for invalid/non-release versions', () => {
  for (const v of ['1.3.1-dev.0', '1.5.0-dev.0', '1.5', 'v1.5.0', '1.5.0-rc', '1.5.0-rc.x', '1.5.0-alpha.1', '', '  1.5.0', null, undefined, 123]) {
    assert.equal(isReleaseVersion(v), false, `expected false for ${JSON.stringify(v)}`);
  }
});

// ---------------------------------------------------------------------------
// B. versionFromPackageJson
// ---------------------------------------------------------------------------
test('versionFromPackageJson — returns version for valid JSON', () => {
  assert.equal(versionFromPackageJson('{"version":"1.5.0-rc.2"}'), '1.5.0-rc.2');
});

test('versionFromPackageJson — throws for missing version field', () => {
  assert.throws(() => versionFromPackageJson('{}'), /no string version/);
});

test('versionFromPackageJson — throws for invalid JSON', () => {
  assert.throws(() => versionFromPackageJson('not json'));
});

// ---------------------------------------------------------------------------
// C. applyVersion
// ---------------------------------------------------------------------------
test('applyVersion — throws for invalid version without calling run', () => {
  const run = makeRun();
  assert.throws(
    () => applyVersion('1.3.1-dev.0', { run }),
    /refusing to sync next to invalid\/non-release version/,
  );
  assert.equal(run.calls.length, 0, 'run should not have been called');
});

test('applyVersion — calls npm version once with correct args for valid version', () => {
  const run = makeRun([{ cmd: 'npm', returns: '' }]);
  applyVersion('1.5.0', { run });
  assert.equal(run.calls.length, 1);
  const [call] = run.calls;
  assert.equal(call.cmd, 'npm');
  assert.deepEqual(call.args, ['version', '1.5.0', '--no-git-tag-version', '--allow-same-version']);
});

// ---------------------------------------------------------------------------
// D. syncViaPr — idempotent (version already matches)
// ---------------------------------------------------------------------------
test('syncViaPr — noop when next is already at the target version', () => {
  const run = makeRun([
    // git fetch — just returns
    { cmd: 'git', args0: 'fetch', returns: '' },
    // git show — returns the SAME version as target
    { cmd: 'git', args0: 'show', returns: '{"version":"1.5.0-rc.2"}' },
  ]);
  const result = syncViaPr('1.5.0-rc.2', { run });
  assert.equal(result, 'noop');
  // Must NOT have called checkout, commit, or gh
  const cmdArgs = run.calls.map((c) => `${c.cmd} ${c.args[0]}`);
  assert.ok(!cmdArgs.some((s) => s.includes('checkout')), 'should not checkout');
  assert.ok(!cmdArgs.some((s) => s.includes('commit')), 'should not commit');
  assert.ok(!cmdArgs.some((s) => s === 'gh pr'), 'should not call gh');
  assert.ok(!run.calls.some((c) => c.cmd === 'gh'), 'should not call gh at all');
});

// ---------------------------------------------------------------------------
// E. syncViaPr — happy path (version differs, diff present)
// ---------------------------------------------------------------------------
test('syncViaPr — happy path: syncs and returns "synced"', () => {
  const run = makeRun([
    { cmd: 'git', args0: 'fetch', returns: '' },
    { cmd: 'git', args0: 'show', returns: '{"version":"1.4.0"}' },
    { cmd: 'git', args0: 'checkout', returns: '' },
    { cmd: 'npm', returns: '' },
    { cmd: 'git', args0: 'add', returns: '' },
    // diff --cached --quiet throws with status 1 → there IS a staged diff
    { cmd: 'git', args0: 'diff', throws: Object.assign(new Error('diff'), { status: 1 }) },
    { cmd: 'git', args0: 'commit', returns: '' },
    { cmd: 'git', args0: 'push', returns: '' },
    // gh pr list returns '' → no existing PR, so create path runs
    { cmd: 'gh', args0: 'pr', args1: 'list', returns: '' },
    { cmd: 'gh', args0: 'pr', args1: 'create', returns: 'https://github.com/o/r/pull/777\n' },
    { cmd: 'gh', args0: 'pr', args1: 'edit', returns: '' },
    { cmd: 'gh', args0: 'pr', args1: 'merge', returns: '' },
  ]);

  const result = syncViaPr('1.5.0-rc.2', { run });
  assert.equal(result, 'synced');

  // Verify ordered calls: checkout -B, npm version, git commit, git push, gh pr create, gh pr merge --admin
  const calls = run.calls;

  const checkoutIdx = calls.findIndex((c) => c.cmd === 'git' && c.args[0] === 'checkout');
  assert.ok(checkoutIdx >= 0, 'should have checkout');
  assert.equal(calls[checkoutIdx].args[1], '-B');

  const npmIdx = calls.findIndex((c) => c.cmd === 'npm');
  assert.ok(npmIdx > checkoutIdx, 'npm version after checkout');

  const commitIdx = calls.findIndex((c) => c.cmd === 'git' && c.args[0] === 'commit');
  assert.ok(commitIdx > npmIdx, 'commit after npm version');

  const pushIdx = calls.findIndex((c) => c.cmd === 'git' && c.args[0] === 'push');
  assert.ok(pushIdx > commitIdx, 'push after commit');

  const prCreateIdx = calls.findIndex((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
  assert.ok(prCreateIdx > pushIdx, 'gh pr create after push');

  const prMergeIdx = calls.findIndex((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge');
  assert.ok(prMergeIdx > prCreateIdx, 'gh pr merge after gh pr create');
  assert.ok(calls[prMergeIdx].args.includes('--admin'), 'merge uses --admin');

  // Assert branch name
  const checkoutCall = calls[checkoutIdx];
  const branchArg = checkoutCall.args[2]; // git checkout -B <branch> origin/next
  assert.ok(branchArg.includes('chore/sync-next-version-1.5.0-rc.2'), `branch should contain 'chore/sync-next-version-1.5.0-rc.2', got '${branchArg}'`);
});

// ---------------------------------------------------------------------------
// F. syncViaPr — rejects invalid version before any run call
// ---------------------------------------------------------------------------
test('syncViaPr — throws for invalid version before calling run', () => {
  const run = makeRun();
  assert.throws(
    () => syncViaPr('1.3.1-dev.0', { run }),
    /refusing to sync next to invalid\/non-release version/,
  );
  assert.equal(run.calls.length, 0, 'run must not be called');
});

// ---------------------------------------------------------------------------
// G. main — --in-place routes to applyVersion; no PR/fetch/checkout
// ---------------------------------------------------------------------------
test('main --in-place calls npm version and does not fetch/checkout/gh', () => {
  const run = makeRun([{ cmd: 'npm', returns: '' }]);
  main(['1.5.0', '--in-place'], { run });
  assert.ok(run.calls.some((c) => c.cmd === 'npm'), 'should call npm');
  assert.ok(!run.calls.some((c) => c.cmd === 'git' && c.args[0] === 'fetch'), 'should not fetch');
  assert.ok(!run.calls.some((c) => c.cmd === 'git' && c.args[0] === 'checkout'), 'should not checkout');
  assert.ok(!run.calls.some((c) => c.cmd === 'gh'), 'should not call gh');
});

test('main (no --in-place) with matching version → noop via syncViaPr', () => {
  const run = makeRun([
    { cmd: 'git', args0: 'fetch', returns: '' },
    { cmd: 'git', args0: 'show', returns: '{"version":"1.5.0"}' },
  ]);
  // Should not throw; syncViaPr returns 'noop'
  main(['1.5.0'], { run });
  assert.ok(!run.calls.some((c) => c.cmd === 'gh'), 'should not call gh on noop');
});

// ---------------------------------------------------------------------------
// H. syncViaPr — reuses existing open PR
// ---------------------------------------------------------------------------
test('syncViaPr — reuses an existing open PR instead of creating', () => {
  const run = makeRun([
    { cmd: 'git', args0: 'fetch', returns: '' },
    { cmd: 'git', args0: 'show', returns: '{"version":"1.4.0"}' },
    { cmd: 'git', args0: 'checkout', returns: '' },
    { cmd: 'npm', returns: '' },
    { cmd: 'git', args0: 'add', returns: '' },
    { cmd: 'git', args0: 'diff', throws: Object.assign(new Error('diff'), { status: 1 }) },
    { cmd: 'git', args0: 'commit', returns: '' },
    { cmd: 'git', args0: 'push', returns: '' },
    // gh pr list returns an existing PR URL
    { cmd: 'gh', args0: 'pr', args1: 'list', returns: 'https://github.com/o/r/pull/555\n' },
    { cmd: 'gh', args0: 'pr', args1: 'edit', returns: '' },
    { cmd: 'gh', args0: 'pr', args1: 'merge', returns: '' },
  ]);

  const result = syncViaPr('1.5.0-rc.2', { run });
  assert.equal(result, 'synced');

  // Must NOT have called gh pr create
  assert.ok(
    !run.calls.some((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create'),
    'should not call gh pr create when existing PR found',
  );

  // Admin merge must target PR 555
  const mergeCall = run.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge');
  assert.ok(mergeCall, 'should call gh pr merge');
  assert.ok(mergeCall.args.includes('555'), 'merge should target PR 555');
});

// ---------------------------------------------------------------------------
// I. syncViaPr — rethrows when git diff fails for a non-diff reason
// ---------------------------------------------------------------------------
test('syncViaPr — rethrows when git diff fails for a non-diff reason', () => {
  const run = makeRun([
    { cmd: 'git', args0: 'fetch', returns: '' },
    { cmd: 'git', args0: 'show', returns: '{"version":"1.4.0"}' },
    { cmd: 'git', args0: 'checkout', returns: '' },
    { cmd: 'npm', returns: '' },
    { cmd: 'git', args0: 'add', returns: '' },
    // git diff throws with status 128 → real error, not a diff signal
    { cmd: 'git', args0: 'diff', throws: Object.assign(new Error('fatal: not a git repo'), { status: 128 }) },
  ]);

  assert.throws(
    () => syncViaPr('1.5.0-rc.2', { run }),
    /fatal: not a git repo/,
    'should rethrow the real error',
  );
});

// ---------------------------------------------------------------------------
// J. syncViaPr — a merge-queue base rejects --admin; enqueue instead (#5746)
// ---------------------------------------------------------------------------

/**
 * A `run` seam for the post-push half of the sync: the PR already exists, so only the
 * `gh pr merge` calls matter. `mergeResults` maps a merge flag (`--admin` / `--auto`) to
 * what that call does: an Error to throw, or a string to return.
 */
function makeMergeRun(mergeResults) {
  const calls = [];
  function run(cmd, args, opts) {
    calls.push({ cmd, args: [...args], opts });
    if (cmd === 'git' && args[0] === 'show') return '{"version":"1.4.0"}';
    if (cmd === 'git' && args[0] === 'diff') throw Object.assign(new Error('diff'), { status: 1 });
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return 'https://github.com/o/r/pull/777\n';
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
      const flag = args.includes('--admin') ? '--admin' : '--auto';
      const outcome = mergeResults[flag];
      if (outcome instanceof Error) throw outcome;
      return outcome ?? '';
    }
    return '';
  }
  run.calls = calls;
  return run;
}

/**
 * The error `execFileSync` raises for a failed `gh` call whose stderr was PIPED: the
 * message is only "Command failed: ..." and the GitHub text lives on `err.stderr`.
 * (With stderr inherited, `err.stderr` is null and the text never reaches the process —
 * see the defaultRun test below — so a fake that put the text in `.message` would
 * describe a failure production never produces.)
 */
function ghFailure(stderrText) {
  return Object.assign(new Error('Command failed: gh pr merge 777'), { stderr: stderrText });
}

const MERGE_QUEUE_REJECTION = ghFailure(
  'GraphQL: Repository rule violations found\n\nChanges must be made through the merge queue\n\n (mergePullRequest)\n',
);

const mergeCalls = (run) => run.calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge');

test('syncViaPr — enqueues with --auto when the base requires the merge queue (#5746)', () => {
  const run = makeMergeRun({ '--admin': MERGE_QUEUE_REJECTION });
  const result = syncViaPr('1.5.0', { run });
  assert.equal(result, 'queued');
  const merges = mergeCalls(run);
  assert.equal(merges.length, 2, 'one --admin attempt, then one --auto enqueue');
  assert.ok(merges[0].args.includes('--admin'));
  assert.deepEqual(merges[1].args, ['pr', 'merge', '--auto', '777'], 'the queue picks the strategy, so no --merge');
});

test('syncViaPr — a failed --auto enqueue is not swallowed (#5746)', () => {
  const failure = Object.assign(new Error('Command failed: gh pr merge --auto 777'), {
    stderr: 'auto-merge is not allowed for this repository',
  });
  const run = makeMergeRun({ '--admin': MERGE_QUEUE_REJECTION, '--auto': failure });
  assert.throws(() => syncViaPr('1.5.0', { run }), (err) => err === failure);
});

test('syncViaPr — an unrelated merge failure is rethrown and does not fall back to --auto (#5746)', () => {
  const failure = ghFailure('HTTP 500: internal error');
  const run = makeMergeRun({ '--admin': failure });
  assert.throws(() => syncViaPr('1.5.0', { run }), (err) => err === failure);
  assert.equal(mergeCalls(run).length, 1, 'no enqueue after a failure that is not the merge-queue rule');
});

test('syncViaPr — an already-merged PR is still tolerated and does not enqueue (#5746)', () => {
  const run = makeMergeRun({ '--admin': ghFailure('Pull request #777 is already merged') });
  assert.equal(syncViaPr('1.5.0', { run }), 'synced');
  assert.equal(mergeCalls(run).length, 1);
});

test('syncViaPr — a message naming both the queue and an already-merged PR does not enqueue (#5746)', () => {
  const run = makeMergeRun({
    '--admin': ghFailure('Pull request #777 is already merged (merge queue is not needed)'),
  });
  assert.equal(syncViaPr('1.5.0', { run }), 'synced');
  assert.equal(mergeCalls(run).length, 1, 'already merged wins: --auto must not run on a merged PR');
});

test('syncViaPr — a queue rejection that also says "not mergeable" still enqueues (#5746)', () => {
  const run = makeMergeRun({
    '--admin': ghFailure('Pull request is not mergeable: Changes must be made through the merge queue'),
  });
  assert.equal(syncViaPr('1.5.0', { run }), 'queued');
  assert.deepEqual(mergeCalls(run)[1].args, ['pr', 'merge', '--auto', '777']);
});

test('syncViaPr — the stderr of a failed enqueue is written out before the error propagates (#5746)', (t) => {
  const failure = ghFailure('auto-merge is not enabled for this repository');
  const run = makeMergeRun({ '--admin': MERGE_QUEUE_REJECTION, '--auto': failure });
  const written = [];
  t.mock.method(process.stderr, 'write', (chunk) => { written.push(String(chunk)); return true; });
  assert.throws(() => syncViaPr('1.5.0', { run }), (err) => err === failure);
  assert.ok(written.some((s) => s.includes('auto-merge is not enabled')), 'the GitHub reason must reach the log');
});

test('syncViaPr — both merge calls capture stderr so a failure carries its own text (#5746)', () => {
  const run = makeMergeRun({ '--admin': MERGE_QUEUE_REJECTION });
  syncViaPr('1.5.0', { run });
  for (const call of mergeCalls(run)) {
    assert.equal(call.opts.stdio[2], 'pipe', `${call.args.join(' ')} must pipe stderr, not inherit it`);
  }
});

test('defaultRun — stderr is on err.stderr only when it is piped (why syncViaPr pipes it) (#5746)', () => {
  // The phrase is assembled at runtime: execFileSync's message embeds the full command line,
  // so a literal in the script would put the phrase in err.message and defeat the assertion.
  const script = 'process.stderr.write(["merge", "queue"].join(" ")); process.exit(1);';
  const piped = (() => {
    try { defaultRun(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) { return err; }
    return null;
  })();
  assert.ok(piped, 'the child exits non-zero, so defaultRun throws');
  assert.match(String(piped.stderr), /merge queue/, 'piped stderr is delivered on err.stderr');

  // stderr NOT captured (`ignore` here to keep the test log quiet; the default `inherit` behaves the
  // same for the error object): err.stderr is null and the message omits the text, so a failure
  // could not be classified.
  const inherited = (() => {
    try { defaultRun(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (err) { return err; }
    return null;
  })();
  assert.ok(inherited);
  assert.doesNotMatch(String(inherited.stderr || '') + inherited.message, /merge queue/);
});
