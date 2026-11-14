'use strict';

/**
 * #5469 — /gsd-pr-branch repeat publishes, part 4 of 6: dirty-tree refusals, nothing-new-to-publish runs and the printed discard command.
 * Runs the shipped bash blocks against real git fixtures; the shared fixtures are in
 * `tests/helpers/pr-branch-published-fixture.cjs`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { git, commitAll, write, commitRound, publish, runSh, mergePr, printedCmd, markerOf, refsOf, onlyRound2, amendedMerged, useRepos } = require('./helpers/pr-branch-published-fixture.cjs');

describe('#5469 pr-branch published marker (real git): refusals', () => {
  const repo = useRepos();

  test('a dirty tree refuses before promoting or dropping the pending build', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    mergePr(dir);
    commitRound(dir, 2);
    write(dir, 'code.txt', 'dirty\n');
    const before = refsOf(dir);
    const r = publish(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Working tree has uncommitted changes/);
    assert.deepEqual(refsOf(dir), before, 'a refused run changes no ref');
  });

  test('nothing new to publish: the merged build is promoted and the run exits 0', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const tip1 = git(dir, 'rev-parse', 'feature');
    mergePr(dir);
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No commits ahead/);
    assert.equal(markerOf(dir), tip1);
  });

  test('nothing new to publish and a dirty tree: refused, every ref unchanged', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    mergePr(dir);
    write(dir, 'code.txt', 'dirty\n');
    const before = refsOf(dir);
    const r = publish(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Working tree has uncommitted changes/);
    assert.deepEqual(refsOf(dir), before, 'a refused run changes no ref');
  });

  test('nothing new to publish and an unmerged leftover -pr: refused, every ref unchanged', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const before = refsOf(dir);
    const r = publish(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /feature-pr exists and is not merged into main/);
    assert.deepEqual(refsOf(dir), before, 'a refused run changes no ref');
  });

  test('-pr merged as built, then given a commit: the build still counts as published; the menu only offers discarding the branch', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const tip1 = git(dir, 'rev-parse', 'feature');
    mergePr(dir);
    git(dir, 'checkout', '-q', 'feature-pr');
    write(dir, 'extra.txt', 'x\n');
    commitAll(dir, 'chore: extra on -pr');
    git(dir, 'checkout', '-q', 'feature');
    commitRound(dir, 2, 'two.txt');
    const before = refsOf(dir);
    const r = publish(dir);
    assert.notEqual(r.status, 0);
    assert.deepEqual(refsOf(dir), before, 'a refused run changes no ref');
    assert.equal(splitLines(r.stderr).filter((l) => l.startsWith('  discard: ')).length, 1, 'exactly one discard option');
    assert.doesNotMatch(r.stderr, /update-ref/, 'the build is proven merged, so no menu line forgets it');
    assert.equal(runSh(printedCmd(r.stderr, 'discard'), dir).status, 0);
    onlyRound2(publish(dir), dir);
    assert.equal(markerOf(dir), tip1);
  });

  test('the git merge proofs run through run-with-timeout (no timeout binary needed)', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    mergePr(dir);
    commitRound(dir, 2);
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(dir, '.git', 'rwt.log'), 'utf-8'), /^run-with-timeout 10 -- git merge-base --is-ancestor/m, 'git ran bounded');
  });

  test('the printed discard command and a drop verdict forget the same refs', () => {
    const refs = (dir) => git(dir, 'for-each-ref', '--format=%(refname)', 'refs/gsd');
    const dropped = repo();
    commitRound(dropped, 1);
    assert.equal(publish(dropped).status, 0);
    git(dropped, 'branch', '-D', 'feature-pr');
    // afterPre stands in for the outward steps: it records the refs once the preconditions have settled the drop.
    const r = publish(dropped, 'main', { afterPre: "git for-each-ref --format='%(refname)' refs/gsd > .git/after-drop.txt; exit 0" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /dropped the pending build/);
    const discarded = repo();
    commitRound(discarded, 1);
    assert.equal(publish(discarded).status, 0);
    const refused = publish(discarded);
    assert.notEqual(refused.status, 0);
    assert.equal(runSh(printedCmd(refused.stderr, 'discard'), discarded).status, 0);
    assert.equal(refs(discarded), fs.readFileSync(path.join(dropped, '.git', 'after-drop.txt'), 'utf-8').trim(), 'both leave the same refs/gsd set');
  });

  test('promote then refuse: an unmerged -pr that lacks the merged built tip leaves refs untouched', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const tip1 = git(dir, 'rev-parse', 'feature');
    mergePr(dir);
    git(dir, 'checkout', '-q', '-b', 'stray', 'main~1');
    write(dir, 'other.txt', 'x\n');
    commitAll(dir, 'chore: stray');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'branch', '-f', 'feature-pr', 'stray');
    commitRound(dir, 2);
    const before = refsOf(dir);
    const r = publish(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /feature-pr exists and is not merged into main/);
    assert.deepEqual(refsOf(dir), before, 'a refused run changes no ref');
    assert.equal(splitLines(r.stderr).filter((l) => l.startsWith('  discard: ')).length, 1, 'exactly one discard option is printed');
    assert.equal(printedCmd(r.stderr, 'discard'), 'git branch -D feature-pr', 'the build is proven merged, so the menu must not offer to forget it');
    assert.equal(runSh(printedCmd(r.stderr, 'discard'), dir).status, 0);
    onlyRound2(publish(dir), dir);
    assert.equal(markerOf(dir), tip1);
  });

  for (const [label, edit] of [['conflicting', { file: 'code.txt', text: 'v1-edited-later\n' }], ['non-conflicting', { file: 'other.txt', text: 'x\n' }]]) {
    test(`-pr amended after the build, merged, then a ${label} target edit: refused naming it; the printed re-anchor lets the next run replay only round 2`, () => {
      const { dir, tip1 } = amendedMerged(repo, edit);
      const before = refsOf(dir);
      const r = publish(dir);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /feature-pr is merged into main but no longer holds the pending build/);
      assert.deepEqual(refsOf(dir), before, 'a refused run changes nothing');
      assert.equal(runSh(printedCmd(r.stderr, 'published (re-anchor)'), dir).status, 0, 'the printed re-anchor command runs');
      onlyRound2(publish(dir), dir);
      assert.equal(markerOf(dir), tip1);
    });
  }
});
