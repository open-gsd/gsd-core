'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isReleaseVersion, versionFromPackageJson, applyVersion, syncViaPr, main } = require('../scripts/sync-next-version.cjs');

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
    // diff --cached --quiet throws → there IS a staged diff
    { cmd: 'git', args0: 'diff', throws: Object.assign(new Error('diff'), { status: 1 }) },
    { cmd: 'git', args0: 'commit', returns: '' },
    { cmd: 'git', args0: 'push', returns: '' },
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
