'use strict';

/**
 * #5469 — /gsd-pr-branch repeat publishes, part 5 of 6: the patch-id matcher over published rounds that were rebased, squashed or rewritten.
 * Runs the shipped bash blocks against real git fixtures; the shared fixtures are in
 * `tests/helpers/pr-branch-published-fixture.cjs`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { MARKER, PENDING, BUILT, git, commitAll, write, commitRound, publish, runSh, mergePr, probePrMerged, builtOf, rebaseMergePr, changed, ghPrelude, publishedWhileMainMoves, WARNED, useRepos } = require('./helpers/pr-branch-published-fixture.cjs');

describe('#5469 pr-branch published marker (real git): matcher', () => {
  const repo = useRepos();

  test('rebased working branch after a published round: the patch-equivalent commit is the base; nothing is replayed, no warning', () => {
    const { dir, prelude } = publishedWhileMainMoves(repo);
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.deepEqual(changed(dir), ['r2.txt', 'two.txt']);
    const rwt = fs.readFileSync(path.join(dir, '.git', 'rwt.log'), 'utf-8');
    assert.match(rwt, /^run-with-timeout 60 -- git -c color.ui=never -c diff.relative=false log -p /m, 'the patch walk ran bounded (60 s), with its output config pinned');
    // Every walk and the checkout take the 60 s bound, not the 10 s default.
    for (const call of ['git patch-id --stable', 'git rev-list --no-merges --left-only', 'git rev-list --no-merges --topo-order --right-only',
      'git log --oneline', 'git rev-list --reverse', 'git checkout -q --no-track -B', 'git diff -z --name-only', 'git rev-list --count']) {
      assert.ok(splitLines(rwt).some((l) => l.startsWith(`run-with-timeout 60 -- ${call}`)), `${call} ran with TO=60:\n${rwt}`);
    }
  });

  test('default mode: published code-only commits rebase-merged, then `git rebase main`: no warning, only round 2 is replayed', () => {
    const dir = repo();
    write(dir, 'x1.txt', '1\n');
    commitAll(dir, 'feat: code only 1');
    assert.equal(publish(dir, 'main', { mode: 'false' }).status, 0);
    rebaseMergePr(dir);
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { mode: 'false' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.ok(changed(dir).includes('two.txt'));
  });

  test('two published code commits squash-merged, then `git rebase main` drops them: no warning, only round 2 is replayed', () => {
    const dir = repo();
    write(dir, 'x1.txt', '1\n');
    commitAll(dir, 'feat: code only 1');
    write(dir, 'x2.txt', '2\n');
    commitAll(dir, 'feat: code only 2');
    assert.equal(publish(dir).status, 0);
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--squash', 'feature-pr');
    git(dir, 'commit', '-q', '-m', 'feat: squash of the round (#1)');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.deepEqual(changed(dir), ['r2.txt', 'two.txt']);
  });

  test('default mode: a mixed commit with transient planning files, rebase-merged then rebased: no warning, only round 2 is replayed', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir, 'main', { mode: 'false' }).status, 0);
    rebaseMergePr(dir);
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { mode: 'false' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.ok(changed(dir).includes('two.txt') && !changed(dir).includes('r1.txt'), 'round 1 is not replayed');
  });

  test('published mixed commit rebase-merged, then `git rebase main`: no warning, only round 2 is replayed', () => {
    const dir = repo();
    write(dir, 'x1.txt', '1\n');
    commitAll(dir, 'feat: code only');
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    rebaseMergePr(dir);
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.deepEqual(changed(dir), ['r2.txt', 'two.txt']);
  });

  test('published code-only commits rebase-merged onto a moved target, then `git rebase main` drops them: no warning, only round 2 is replayed', () => {
    const dir = repo();
    write(dir, 'x1.txt', '1\n');
    commitAll(dir, 'feat: code only 1');
    write(dir, 'x2.txt', '2\n');
    commitAll(dir, 'feat: code only 2');
    assert.equal(publish(dir).status, 0);
    rebaseMergePr(dir);
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.deepEqual(changed(dir), ['r2.txt', 'two.txt']);
  });

  test('a failed or timed-out patch lookup warns instead of skipping unpublished commits', () => {
    const { dir, prelude } = publishedWhileMainMoves(repo);
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    // run-with-timeout reports 124 for the patch walk only; every other call runs as usual
    const r = publish(dir, 'main', { prelude, arms: '*"log -p"*) return 124 ;;' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, WARNED);
    assert.ok(changed(dir).includes('two.txt'), 'round 2 is still replayed');
  });

  // Each list read of the rewrite must fail the whole lookup: a failed read leaves an empty list that would match anything.
  for (const [what, pattern] of [['right-side commit list', '*"--topo-order --right-only"*'], ['changed-path list', '*"diff --name-only --no-renames "[0-9a-f]*'], ['file list per commit', '*"log --full-history --name-only"*']]) {
    test(`a failed ${what} warns instead of skipping unpublished commits`, () => {
      const { dir, prelude } = publishedWhileMainMoves(repo);
      git(dir, 'rebase', '-q', 'main');
      commitRound(dir, 2, 'two.txt');
      const r = publish(dir, 'main', { prelude, arms: `${pattern}) return 1 ;;` });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, WARNED);
    });
  }

  test('a patch walk killed after partial output warns: the cut commit is not read as unpublished', () => {
    const { dir, prelude } = publishedWhileMainMoves(repo);
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    // run-with-timeout cuts the last two lines off the patch walk (inside its oldest patch) and reports 124
    const cut = `*"log -p"*) "$@" | awk '{a[NR]=$0} END{for(i=1;i<=NR-2;i++)print a[i]}'; return 124 ;;`;
    const r = publish(dir, 'main', { prelude, arms: cut });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, WARNED);
  });

  test('a picked commit the patch-id run left out warns instead of being read as unpublished', () => {
    const { dir, prelude } = publishedWhileMainMoves(repo);
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    const picked = git(dir, 'rev-parse', 'HEAD~1'); // the `feat: r2` commit
    // run-with-timeout drops that commit's line from the patch-id output; every other call runs as usual
    const lossy = `*patch-id*) "$@" | grep -v " ${picked}$"; return 0 ;;`;
    const r = publish(dir, 'main', { prelude, arms: lossy });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, WARNED);
  });

  test('a published commit the patch-id run left out warns even when the lookup succeeded', () => {
    const { dir, prelude } = publishedWhileMainMoves(repo);
    const built = git(dir, 'rev-parse', 'feature~1'); // the published `feat: r1` commit, before the rebase rewrites it
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    // the patch-id output loses that commit's line; every other call runs as usual
    const lossy = `*patch-id*) "$@" | grep -v " ${built}$"; return 0 ;;`;
    const r = publish(dir, 'main', { prelude, arms: lossy });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, WARNED);
  });

  // Default mode keeps .planning/config.json out of the pick, but the patch walk still sees it as a kept path.
  test('default mode: a recorded config.json-only commit that is gone from the rebased branch is not a published commit to match', () => {
    const dir = repo();
    write(dir, 'x.txt', 'x\n');
    commitAll(dir, 'feat: code');
    write(dir, '.planning/config.json', '{}\n');
    commitAll(dir, 'chore: config only');
    git(dir, 'update-ref', 'refs/gsd/pr-published/default/main/feature', 'feature');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'other.txt', 'o\n');
    commitAll(dir, 'chore: main moves on');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'reset', '-q', '--hard', 'feature~1'); // the config.json commit is dropped
    git(dir, 'rebase', '-q', 'main');
    write(dir, 'y.txt', 'y\n');
    commitAll(dir, 'feat: more code');
    const r = publish(dir, 'main', { mode: 'false' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
  });

  // The side commit and the line commit add the same file, so the merge equals its first parent and a path-limited
  // log without --full-history leaves the side commit out of the patch-id input.
  test('a side branch merged into the working branch: every picked commit still has a patch-id, so no warning', () => {
    const { dir, prelude } = publishedWhileMainMoves(repo);
    git(dir, 'rebase', '-q', 'main');
    git(dir, 'checkout', '-q', '-b', 'side');
    write(dir, 's.txt', 'X\n');
    commitAll(dir, 'feat: side');
    git(dir, 'checkout', '-q', 'feature');
    write(dir, 's.txt', 'X\n');
    commitAll(dir, 'feat: same file on the line');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
  });

  // The recorded tip is a merge whose side commit adds only a file the line commit adds too (so the merge equals its
  // first parent); that side commit is published, unmatched and changed on the target, so the rewrite must warn.
  test('a recorded tip with a merged side commit: the side commit is still judged, so the rewrite warns', () => {
    const dir = repo();
    write(dir, 't.txt', 'X\n');
    write(dir, 'u.txt', 'U\n');
    commitAll(dir, 'feat: t and u again'); // the oldest commit of the branch: same patch as the line commit below
    commitRound(dir, 1);
    git(dir, 'checkout', '-q', '-b', 'old', 'main');
    git(dir, 'checkout', '-q', '-b', 'side2');
    write(dir, 't.txt', 'X\n');
    commitAll(dir, 'feat: side only t');
    git(dir, 'checkout', '-q', 'old');
    write(dir, 't.txt', 'X\n');
    write(dir, 'u.txt', 'U\n');
    commitAll(dir, 'feat: line t and u');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge side2', 'side2');
    git(dir, 'update-ref', MARKER, 'old');
    git(dir, 'checkout', '-q', 'feature');
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, WARNED);
  });

  // Squash-merged, then the target renamed a file the published commit changed: the old name is gone from the target.
  test('published file renamed on the target after a squash of two commits: the rewrite warns instead of trusting the rename', () => {
    const dir = repo();
    write(dir, 'x1.txt', '1\n');
    commitAll(dir, 'feat: code only 1');
    write(dir, 'x2.txt', '2\n');
    commitAll(dir, 'feat: code only 2');
    assert.equal(publish(dir).status, 0);
    const prelude = ghPrelude(repo, builtOf(dir));
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--squash', 'feature-pr');
    git(dir, 'commit', '-q', '-m', 'feat: squash of the round (#1)');
    git(dir, 'mv', 'x1.txt', 'moved1.txt');
    commitAll(dir, 'chore: rename x1.txt');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'reset', '-q', '--hard', 'main');
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, WARNED);
  });

  test('a merged leftover -pr with nothing recorded as published warns that every commit is picked again', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    mergePr(dir);
    for (const ref of [MARKER, PENDING, BUILT]) git(dir, 'update-ref', '-d', ref);
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /feature-pr is merged into main but nothing is recorded as published for feature in strict mode/);
    assert.match(r.stderr, /git update-ref refs\/gsd\/pr-published\/strict\/main\/feature <last published commit/);
  });

  test('rebased working branch with an unpublished commit reordered below a published code commit: warns and uses the target', () => {
    const { dir, prelude } = publishedWhileMainMoves(repo);
    write(dir, 'u.txt', 'u\n');
    commitAll(dir, 'feat: unpublished');
    const [c1, d1, u] = splitLines(git(dir, 'log', '--reverse', '--format=%H', 'feature', '--not', 'main'));
    git(dir, 'checkout', '-q', '-B', 'tmp', 'main');
    git(dir, 'cherry-pick', u, c1, d1);
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'reset', '-q', '--hard', 'tmp');
    const r = publish(dir, 'main', { prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, WARNED);
    assert.ok(changed(dir).includes('u.txt'), 'the unpublished commit is replayed');
  });

  test('rebased working branch whose published round was folded into one new patch: warns with the re-anchor command', () => {
    const { dir, prelude } = publishedWhileMainMoves(repo);
    git(dir, 'reset', '-q', '--soft', 'main');
    git(dir, 'commit', '-q', '-m', 'feat: folded');
    const r = publish(dir, 'main', { prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /not an ancestor of feature[\s\S]*Re-anchor: git update-ref \S+ <rebased commit equivalent to last published tip>/);
  });

  test('pr_merged ignores diff.relative: a squash-merged change outside the subdirectory is still proven from inside it', () => {
    const dir = repo();
    write(dir, 'lib/a.txt', 'a\n');
    commitAll(dir, 'chore: lib exists');
    git(dir, 'checkout', '-q', '-b', 'feature-pr', 'main');
    write(dir, 'outside.txt', 'o\n');
    commitAll(dir, 'feat: outside lib');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'outside.txt', 'o\n');
    commitAll(dir, 'feat: squashed outside lib');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'config', 'diff.relative', 'true');
    assert.equal(probePrMerged(path.join(dir, 'lib')), 'MERGED');
  });

  test('pr_merged ignores diff.relative: an unmerged -pr stays unmerged when judged from the subdirectory it changed', () => {
    const dir = repo();
    write(dir, 'lib/a.txt', 'a\n');
    commitAll(dir, 'feat: lib');
    git(dir, 'branch', 'feature-pr', 'feature');
    git(dir, 'config', 'diff.relative', 'true');
    assert.equal(probePrMerged(path.join(dir, 'lib')), 'UNMERGED');
  });

  test('rebased working branch whose published code commit was conflict-resolved (changed patch): warns, never replays it silently', () => {
    const { dir, prelude } = publishedWhileMainMoves(repo);
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'code.txt', 'v-main\n');
    commitAll(dir, 'chore: main edits code');
    git(dir, 'checkout', '-q', 'feature');
    const rb = runSh("git rebase -q main || { printf 'v-resolved\\n' > code.txt; git add -A; git -c core.editor=true rebase --continue; }", dir);
    assert.equal(rb.status, 0, rb.stderr);
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, WARNED);
  });

  // The patch walk must not depend on the user's git output config.
  test('color.ui=always: the rebased round still matches its published patch; only round 2 is replayed', () => {
    const { dir, prelude } = publishedWhileMainMoves(repo);
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    git(dir, 'config', 'color.ui', 'always');
    const r = publish(dir, 'main', { prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.deepEqual(changed(dir), ['r2.txt', 'two.txt']);
  });

  test('color.diff=always: the rebased round still matches its published patch; only round 2 is replayed', () => {
    const { dir, prelude } = publishedWhileMainMoves(repo);
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    git(dir, 'config', 'color.diff', 'always');
    const r = publish(dir, 'main', { prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.deepEqual(changed(dir), ['r2.txt', 'two.txt']);
  });

  test('diff.relative=true, run from .planning/phases: the rebased round still matches; only round 2 is replayed', () => {
    const { dir, prelude } = publishedWhileMainMoves(repo);
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    git(dir, 'config', 'diff.relative', 'true');
    const r = publish(dir, 'main', { prelude, cwd: path.join(dir, '.planning', 'phases') });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.deepEqual(changed(dir), ['r2.txt', 'two.txt']);
  });
});
