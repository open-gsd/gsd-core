'use strict';

/**
 * #5469 — /gsd-pr-branch repeat publishes, part 2 of 6: the merge proofs of a leftover -pr (ancestry, content and gh) and their rename and target handling.
 * Runs the shipped bash blocks against real git fixtures; the shared fixtures are in
 * `tests/helpers/pr-branch-published-fixture.cjs`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { refOf } = require('./helpers/isolated-env.cjs');
const { HOSTILE, git, commitAll, write, commitRound, publish, runSh, mergePr, printedCmd, markerOf, pendingOf, builtOf, squashMerge, onlyRound2, ghPrelude, renameFixture, useRepos } = require('./helpers/pr-branch-published-fixture.cjs');

describe('#5469 pr-branch published marker (real git): merge-proof', () => {
  const repo = useRepos();

  test('squash-merged -pr kept: promoted by content, leftover branch replaced, nothing replayed', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const tip1 = git(dir, 'rev-parse', 'feature');
    squashMerge(dir);
    commitRound(dir, 2);
    onlyRound2(publish(dir), dir);
    assert.equal(markerOf(dir), tip1);
  });

  test('squash-merged -pr deleted afterwards: promoted by content, nothing replayed', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const tip1 = git(dir, 'rev-parse', 'feature');
    squashMerge(dir, { deletePr: true });
    commitRound(dir, 2);
    onlyRound2(publish(dir), dir);
    assert.equal(markerOf(dir), tip1);
  });

  test('rebase-merged -pr (new shas on a moved target): promoted by content', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const tip1 = git(dir, 'rev-parse', 'feature');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'other.txt', 'x\n');
    commitAll(dir, 'chore: unrelated');
    git(dir, 'cherry-pick', 'feature-pr');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'branch', '-D', 'feature-pr');
    commitRound(dir, 2);
    onlyRound2(publish(dir), dir);
    assert.equal(markerOf(dir), tip1);
  });

  test('squash-merged -pr whose files changed on main since: refused, documented commands re-anchor the next run', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    squashMerge(dir, { later: true });
    commitRound(dir, 2, 'two.txt');
    const refused = publish(dir);
    assert.notEqual(refused.status, 0);
    const cmd = printedCmd(refused.stderr, 'published (re-anchor)');
    const recovered = runSh(cmd, dir);
    assert.equal(recovered.status, 0, `recovery command failed: ${recovered.stderr}`);
    const next = publish(dir);
    assert.doesNotMatch(next.stderr, /dropped the pending build/);
    onlyRound2(next, dir);
    assert.equal(git(dir, 'show', 'feature-pr:two.txt'), 'v2');
  });

  test('squash-merged and deleted -pr, files changed on main since: the merge is not proven, so nothing is published', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const pendingBefore = pendingOf(dir);
    squashMerge(dir, { later: true, deletePr: true });
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir);
    assert.equal(r.status, 1, 'replaying r1 over main\'s later edit conflicts and halts');
    assert.equal(markerOf(dir), '', 'unproven merge publishes nothing');
    assert.notEqual(pendingOf(dir), pendingBefore, 'the old pending build was dropped');
  });

  test('gh reporting a different head sha does not promote, so nothing is published', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const pendingBefore = pendingOf(dir);
    squashMerge(dir, { later: true, deletePr: true });
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { prelude: ghPrelude(repo, git(dir, 'rev-parse', 'main')) });
    assert.equal(r.status, 1, 'replaying r1 over main\'s later edit conflicts and halts');
    assert.ok(fs.existsSync(path.join(dir, '.git', 'gh-called')), 'gh was queried, so the verdict is the sha filter\'s');
    assert.equal(markerOf(dir), '');
    assert.notEqual(pendingOf(dir), pendingBefore, 'the old pending build was dropped');
  });

  test('gh queried for another base is ignored: a -pr merged elsewhere never promotes', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const prTip = builtOf(dir);
    const pendingBefore = pendingOf(dir);
    squashMerge(dir, { later: true, deletePr: true });
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { prelude: ghPrelude(repo, prTip, 'release') });
    assert.equal(r.status, 1, 'replaying r1 over main\'s later edit conflicts and halts');
    assert.ok(fs.existsSync(path.join(dir, '.git', 'gh-called')), 'gh was queried, so the verdict is the sha filter\'s');
    assert.equal(markerOf(dir), '');
    assert.notEqual(pendingOf(dir), pendingBefore, 'the old pending build was dropped');
  });

  test('renamed file in the -pr diff: both sides are compared (--no-renames), squash merge still proven', () => {
    const dir = renameFixture(repo);
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'rm', '-q', 'old.txt');
    git(dir, 'checkout', 'feature-pr', '--', 'new.txt', 'code.txt');
    commitAll(dir, 'feat: squashed rename');
    write(dir, 'other.txt', 'x\n');
    commitAll(dir, 'chore: unrelated');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'branch', '-D', 'feature-pr');
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir);
    onlyRound2(r, dir);
  });

  test('squash-merged and deleted -pr, files changed on main since: a merged PR reported by gh proves it', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const tip1 = git(dir, 'rev-parse', 'feature');
    const prTip = builtOf(dir);
    squashMerge(dir, { later: true, deletePr: true });
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { prelude: ghPrelude(repo, prTip) });
    onlyRound2(r, dir);
    assert.equal(markerOf(dir), tip1);
  });

  // An executable gh is bounded by `gsd_run run-with-timeout`, which needs no timeout binary (stock macOS).
  test('executable gh: the lookup runs through run-with-timeout and proves the merge', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const tip1 = git(dir, 'rev-parse', 'feature');
    const prTip = builtOf(dir);
    squashMerge(dir, { later: true, deletePr: true });
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { prelude: ghPrelude(repo, prTip) });
    onlyRound2(r, dir);
    assert.equal(markerOf(dir), tip1);
    assert.match(fs.readFileSync(path.join(dir, '.git', 'rwt.log'), 'utf-8'), /^run-with-timeout 10 -- gh pr list/m, 'gh ran bounded');
  });

  test('renamed file, squash merge on main keeps old.txt: the merge is not proven, so nothing is published (--no-renames)', () => {
    const dir = renameFixture(repo);
    const pendingBefore = pendingOf(dir);
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'checkout', 'feature-pr', '--', 'new.txt', 'code.txt'); // old.txt stays on main
    commitAll(dir, 'feat: squashed, rename deletion missing');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'branch', '-D', 'feature-pr');
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!splitLines(git(dir, 'ls-tree', '-r', '--name-only', 'feature-pr')).includes('old.txt'), 'the unproven rename round is replayed');
    assert.equal(markerOf(dir), '');
    assert.notEqual(pendingOf(dir), pendingBefore, 'the old pending build was dropped');
  });

  test('target origin/main: gh is queried with --base main (remote prefix stripped)', () => {
    const dir = repo();
    git(dir, 'remote', 'add', 'origin', path.join(dir, 'no-such-remote'));
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
    commitRound(dir, 1);
    assert.equal(publish(dir, 'origin/main').status, 0);
    const key = 'origin%2Fmain/feature';
    const prTip = refOf(dir, `refs/gsd/pr-built-head/strict/${key}`);
    const tip1 = git(dir, 'rev-parse', 'feature');
    squashMerge(dir, { later: true, deletePr: true });
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'origin/main', { prelude: ghPrelude(repo, prTip) });
    onlyRound2(r, dir);
    assert.equal(refOf(dir, `refs/gsd/pr-published/strict/${key}`), tip1);
  });

  test('switching planning.pr_strict between runs does not reuse the other mode\'s marker', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    mergePr(dir);
    assert.equal(markerOf(dir), '');
    assert.ok(pendingOf(dir));
    commitRound(dir, 2);
    const r = publish(dir, 'main', { mode: 'false' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(refOf(dir, 'refs/gsd/pr-built/default/main/feature'), git(dir, 'rev-parse', 'feature'), 'default mode keeps its own pending ref');
    assert.equal(refOf(dir, 'refs/gsd/pr-published/default/main/feature'), '');
    assert.ok(pendingOf(dir), 'strict pending untouched');
  });

  test('branches feat and feat/sub both record markers (no ref is a directory prefix of another)', () => {
    const dir = repo();
    commitRound(dir, 1);
    git(dir, 'checkout', '-q', '-b', 'feat');
    assert.equal(publish(dir, 'main', { branch: 'feat' }).status, 0);
    // `feat` and `feat-pr` go, but the refs recorded for `feat` stay: a `feat/sub` marker must not collide with them
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'branch', '-D', 'feat', 'feat-pr');
    git(dir, 'checkout', '-q', '-b', 'feat/sub', 'feature');
    const r = publish(dir, 'main', { branch: 'feat/sub' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(refOf(dir, 'refs/gsd/pr-built/strict/main/feat'), 'the refs of `feat` are still there');
    assert.ok(refOf(dir, 'refs/gsd/pr-built/strict/main/feat%2Fsub'), 'and `feat/sub` recorded its own');
  });

  test('a remote-tracking target (origin/main) is encoded into one ref component', () => {
    const dir = repo();
    commitRound(dir, 1);
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
    const r = publish(dir, 'origin/main');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(refOf(dir, 'refs/gsd/pr-built/strict/origin%2Fmain/feature'));
    assert.equal(refOf(dir, 'refs/gsd/pr-built/strict/origin/main/feature'), '');
  });

  test('the -pr branch built from a remote-tracking target has no upstream (#2498)', () => {
    const dir = repo();
    git(dir, 'remote', 'add', 'origin', path.join(dir, 'no-such-remote'));
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
    commitRound(dir, 1);
    assert.equal(publish(dir, 'origin/main').status, 0);
    assert.equal(git(dir, 'for-each-ref', '--format=%(upstream)', 'refs/heads/feature-pr'), '');
  });

  test('a refused publish on a branch name with shell metacharacters leaves its refs untouched', () => {
    const branch = HOSTILE;
    const dir = repo(branch);
    commitRound(dir, 1);
    assert.equal(publish(dir, 'main', { branch }).status, 0);
    const refs = ['pr-published', 'pr-built', 'pr-built-head'].map((k) => `refs/gsd/${k}/strict/main/${branch}`);
    const before = refs.map((ref) => refOf(dir, ref));
    const prTip = git(dir, 'rev-parse', `${branch}-pr`);
    commitRound(dir, 2);
    const r = publish(dir, 'main', { branch });
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(`${HOSTILE}-pr exists and is not merged into main`), r.stderr);
    assert.equal(git(dir, 'rev-parse', `${branch}-pr`), prTip, 'the refused publish leaves the -pr branch');
    assert.deepEqual(refs.map((ref) => refOf(dir, ref)), before);
    assert.ok(!fs.existsSync(path.join(dir, `${branch}-pr`)) && !fs.existsSync(path.join(dir, 'b$c-pr')), 'no file from the injected suffix');
    assert.equal(runSh(printedCmd(r.stderr, 'published (re-anchor)'), dir).status, 0, 'the printed command runs as one command');
    assert.equal(refOf(dir, `refs/heads/${branch}-pr`), '', 'and deletes the -pr branch');
    assert.ok(!fs.existsSync(path.join(dir, 'b$c-pr')), 'no file from the injected suffix, after running it');
  });

  // The printed discard command must run as one command for a hostile branch name, with and without a pending build.
  for (const withPending of [true, false]) {
    test(`a refused publish on a branch name with shell metacharacters prints a discard command that runs (${withPending ? 'with' : 'without'} a pending build)`, () => {
      const branch = HOSTILE;
      const dir = repo(branch);
      commitRound(dir, 1);
      assert.equal(publish(dir, 'main', { branch }).status, 0);
      if (!withPending) for (const ref of ['pr-built', 'pr-built-head']) git(dir, 'update-ref', '-d', `refs/gsd/${ref}/strict/main/${branch}`);
      commitRound(dir, 2);
      const r = publish(dir, 'main', { branch });
      assert.notEqual(r.status, 0);
      assert.equal(runSh(printedCmd(r.stderr, 'discard'), dir).status, 0, 'the printed command runs as one command');
      assert.equal(refOf(dir, `refs/heads/${branch}-pr`), '', 'and deletes the -pr branch');
      assert.ok(!fs.existsSync(path.join(dir, 'b$c-pr')), 'no file from the injected suffix');
    });
  }

  // The re-anchor commands of the warnings name the marker ref, which may hold shell metacharacters.
  test('the re-anchor command of the pending-drop warning runs for a branch name with shell metacharacters', () => {
    const branch = HOSTILE;
    const dir = repo(branch);
    commitRound(dir, 1);
    assert.equal(publish(dir, 'main', { branch }).status, 0);
    git(dir, 'branch', '-D', `${branch}-pr`);
    commitRound(dir, 2);
    const r = publish(dir, 'main', { branch });
    assert.equal(r.status, 0, r.stderr);
    const cmd = splitLines(r.stderr).map((l) => l.match(/re-anchor: (git update-ref .*)$/)).find(Boolean)[1];
    assert.equal(runSh(cmd, dir).status, 0, 'the printed command runs as one command');
    assert.notEqual(refOf(dir, `refs/gsd/pr-published/strict/main/${branch}`), '', 'it set the marker of that branch');
    assert.ok(!fs.existsSync(path.join(dir, 'b$c')), 'no file from the injected suffix');
  });

  test('the re-anchor command of the history-rewritten warning runs for a branch name with shell metacharacters', () => {
    const branch = HOSTILE;
    const dir = repo(branch);
    write(dir, 'x1.txt', '1\n');
    commitAll(dir, 'feat: code only 1');
    write(dir, 'x2.txt', '2\n');
    commitAll(dir, 'feat: code only 2');
    assert.equal(publish(dir, 'main', { branch }).status, 0);
    // record the round as published by hand, so the next run reads the marker (the gh stub only knows `feature-pr`)
    for (const ref of ['pr-built', 'pr-built-head']) git(dir, 'update-ref', '-d', `refs/gsd/${ref}/strict/main/${branch}`);
    git(dir, 'update-ref', `refs/gsd/pr-published/strict/main/${branch}`, branch);
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--squash', `${branch}-pr`);
    git(dir, 'commit', '-q', '-m', 'feat: squash of the round');
    git(dir, 'mv', 'x1.txt', 'moved1.txt');
    commitAll(dir, 'chore: rename x1.txt');
    git(dir, 'checkout', '-q', branch);
    git(dir, 'branch', '-D', `${branch}-pr`);
    git(dir, 'reset', '-q', '--hard', 'main');
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { branch });
    assert.equal(r.status, 0, r.stderr);
    const m = r.stderr.match(/Re-anchor: (git update-ref .*?) <rebased commit/);
    assert.ok(m, r.stderr);
    assert.equal(runSh(`${m[1]} ${git(dir, 'rev-parse', 'main')}`, dir).status, 0, 'the printed command runs as one command');
    assert.equal(refOf(dir, `refs/gsd/pr-published/strict/main/${branch}`), git(dir, 'rev-parse', 'main'));
    assert.ok(!fs.existsSync(path.join(dir, 'b$c')), 'no file from the injected suffix');
  });
});
