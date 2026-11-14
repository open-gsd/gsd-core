'use strict';

/**
 * #5469 — /gsd-pr-branch repeat publishes, part 6 of 6: the fail-closed paths: failed or timed-out git calls, config-only commits and cut-short lists.
 * Runs the shipped bash blocks against real git fixtures; the shared fixtures are in
 * `tests/helpers/pr-branch-published-fixture.cjs`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { refOf } = require('./helpers/isolated-env.cjs');
const { cleanup } = require('./helpers.cjs');
const { createTempDir } = require('./helpers.cjs');
const { git, commitAll, write, commitRound, publish, runSh, mergePr, probePrMerged, markerOf, pendingOf, builtOf, refsOf, changed, buildRepo, squashMerge, ghPrelude, publishedWhileMainMoves, WARNED, noRefs, useRepos } = require('./helpers/pr-branch-published-fixture.cjs');

describe('#5469 pr-branch published marker (real git): failures', () => {
  const repo = useRepos();

  test('files named L, R, D, F, P and `commit <sha>` do not shift the matcher sections', () => {
    const dir = repo();
    for (const f of ['L', 'R', 'D', 'F', 'P', `commit ${'a'.repeat(40)}`]) write(dir, f, `${f}\n`);
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const prelude = ghPrelude(repo, builtOf(dir));
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'other.txt', 'x\n');
    commitAll(dir, 'chore: unrelated');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.deepEqual(changed(dir), ['r2.txt', 'two.txt']);
  });

  // The published tip was a merge, and the merge was redone, so no non-merge commit is left on the marker side.
  test('marker side made only of a merge: warns and uses the target', () => {
    const dir = repo();
    commitRound(dir, 1);
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'other.txt', 'x\n');
    commitAll(dir, 'chore: unrelated');
    const o = git(dir, 'rev-parse', 'main');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge main', o);
    assert.equal(publish(dir).status, 0);
    mergePr(dir);
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'merge main again', o);
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, WARNED);
  });

  // The gh proof needs the exact sha, not a line that only contains it.
  test('gh reporting a longer sha that starts with the built tip does not prove the merge', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const pendingBefore = pendingOf(dir);
    squashMerge(dir, { later: true, deletePr: true });
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { prelude: ghPrelude(repo, `${builtOf(dir)}0`) });
    assert.equal(r.status, 1, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, '.git', 'gh-called')), 'gh was queried');
    assert.equal(markerOf(dir), '');
    assert.notEqual(pendingOf(dir), pendingBefore, 'the old pending build was dropped');
  });

  // An unpublished commit whose committer date is older than the rebased published copy; only --topo-order keeps the order.
  test('rebased branch with a clock-skewed unpublished commit on top: the published copy is still the base', () => {
    const { dir, prelude } = publishedWhileMainMoves(repo);
    git(dir, 'rebase', '-q', 'main');
    write(dir, 'u.txt', 'u\n');
    git(dir, 'add', '-A');
    const c = runSh("GIT_COMMITTER_DATE='2001-01-01T00:00:00Z' GIT_AUTHOR_DATE='2001-01-01T00:00:00Z' git commit -q -m 'feat: unpublished'", dir);
    assert.equal(c.status, 0, c.stderr);
    const r = publish(dir, 'main', { prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.deepEqual(changed(dir), ['u.txt']);
  });

  // TARGET comes from repo config (git.base_branch), so an option-like value must never reach git.
  test('a target that starts with - is refused and never reaches git as an option', () => {
    const dir = repo();
    commitRound(dir, 1);
    const out = createTempDir('gsd-prmarker-pwned-');
    repo.keep(out);
    const pwned = path.join(out, 'pwned').replace(/\\/g, '/');
    const r = publish(dir, `--output=${pwned}`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /starts with -/);
    assert.doesNotMatch(r.stderr, /Unknown target/, 'the run stopped at the refusal, not at the later lookup');
    assert.ok(!fs.existsSync(pwned), 'git wrote no file');
  });

  // The guard refuses a leading dash only: a dash inside the name is a normal target.
  test('a bare - target is refused; a target with a dash inside is accepted and records its pending build', () => {
    const dir = repo();
    commitRound(dir, 1);
    const dash = publish(dir, '-');
    assert.equal(dash.status, 1);
    assert.match(dash.stderr, /starts with -/);
    assert.doesNotMatch(dash.stderr, /Unknown target/, 'the run stopped at the refusal, not at the later lookup');
    git(dir, 'branch', 'release-1', 'main');
    const r = publish(dir, 'release-1');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(refOf(dir, 'refs/gsd/pr-built/strict/release-1/feature'), git(dir, 'rev-parse', 'feature'));
  });

  // A merged -pr reset to the target holds no built tip; the build is dropped with its WARNING.
  test('merged -pr reset to the target after a promoted round: the next build is dropped with a WARNING naming the fix', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    mergePr(dir);
    commitRound(dir, 2, 'two.txt');
    assert.equal(publish(dir).status, 0);
    const pending = pendingOf(dir);
    git(dir, 'branch', '-f', 'feature-pr', 'main');
    commitRound(dir, 3, 'three.txt');
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WARNING: dropped the pending build/);
    assert.match(r.stderr, /update main, then re-anchor/);
    assert.ok(r.stderr.includes(`git update-ref refs/gsd/pr-published/strict/main/feature ${pending}`), r.stderr);
  });

  // A failed marker write warns. A ref named refs/gsd/pr-published blocks the marker path (a file where a directory is needed).
  test('a failed marker write warns that the next run replays commits', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    mergePr(dir);
    git(dir, 'update-ref', 'refs/gsd/pr-published', 'main');
    commitRound(dir, 2, 'two.txt');
    const before = pendingOf(dir);
    assert.notEqual(before, '', 'round 1 left a pending build');
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WARNING: could not record refs\/gsd\/pr-published\/strict\/main\/feature/);
    assert.equal(pendingOf(dir), before, 'the unpromoted pending build is kept, not overwritten by the new build');
  });

  // The pending write fails the same way; the run warns and records no pending ref.
  test('a failed pending write warns and leaves no pending ref', () => {
    const dir = repo();
    commitRound(dir, 1);
    git(dir, 'update-ref', 'refs/gsd/pr-built-head', 'main');
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WARNING: could not record refs\/gsd\/pr-built-head\/strict\/main\/feature or refs\/gsd\/pr-built\/strict\/main\/feature/, 'both refs are named, so the blocked one is');
    assert.equal(pendingOf(dir), '');
  });

  test('a timed-out read of the built -pr tip warns and records no pending ref', () => {
    const dir = repo();
    commitRound(dir, 1);
    const r = publish(dir, 'main', { arms: '*"git rev-parse refs/heads/feature-pr"*) return 124 ;;' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /WARNING: could not record/);
    assert.equal(pendingOf(dir), '');
    assert.equal(builtOf(dir), '');
  });

  test('an unreadable .planning/milestones stops the run with exit 1 and changes no ref', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
    const dir = buildRepo(); // not repo(): afterEach runs before t.after, and cleanup must read the dir
    const ms = path.join(dir, '.planning', 'milestones');
    t.after(() => { fs.chmodSync(ms, 0o755); cleanup(dir); });
    commitRound(dir, 1);
    fs.mkdirSync(path.join(ms, 'v1-phases'), { recursive: true });
    fs.chmodSync(ms, 0o000);
    const refs = () => git(dir, 'for-each-ref', 'refs/gsd');
    const r = publish(dir, 'main', { mode: 'false' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Cannot list \.planning\/milestones/);
    assert.equal(refs(), '');
    assert.equal(refOf(dir, 'refs/heads/feature-pr'), '');
  });

  // A commit that touches only .planning/config.json is excluded in default mode, as the classification says.
  test('default mode: a config.json-only commit is not picked', () => {
    const dir = repo();
    write(dir, '.planning/config.json', '{"x":1}\n');
    commitAll(dir, 'chore: config');
    write(dir, 'x.txt', 'x\n');
    commitAll(dir, 'feat: code');
    const r = publish(dir, 'main', { mode: 'false' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(changed(dir), ['x.txt']);
  });

  // The pick list per mode: a STATE.md-only commit is picked in default mode only; a transient-only commit never.
  for (const [mode, want] of [['false', ['.planning/STATE.md', 'x.txt']], ['true', ['x.txt']]]) {
    test(`${mode === 'true' ? 'strict' : 'default'} mode: STATE.md-only and transient-only commits are picked as the classification says`, () => {
      const dir = repo();
      write(dir, '.planning/STATE.md', 's1\n');
      commitAll(dir, 'docs: state');
      write(dir, '.planning/phases/p.md', 'p\n');
      commitAll(dir, 'docs: plan');
      write(dir, 'x.txt', 'x\n');
      commitAll(dir, 'feat: code');
      const r = publish(dir, 'main', { mode });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(changed(dir), want);
    });
  }

  // git quotes a non-ASCII path, and one with a double quote, in a plain name list; the pick rule must still see it under .planning/.
  for (const name of ['notes-é.md', 'a"b.md']) {
    test(`default mode: a commit that touches only the "other" planning path ${name} is not picked`, { skip: name.includes('"') && process.platform === 'win32' }, () => {
      const dir = repo();
      write(dir, `.planning/${name}`, 'n\n');
      commitAll(dir, 'docs: notes');
      write(dir, 'x.txt', 'x\n');
      commitAll(dir, 'feat: code');
      const r = publish(dir, 'main', { mode: 'false' });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(changed(dir), ['x.txt']);
    });
  }

  // The matcher skips what the pick list skips: an unpublished config.json-only commit below the published copy.
  test('default mode: a new config.json-only commit below the rebased published round: no warning, only round 2 is replayed', () => {
    const dir = repo();
    write(dir, 'x1.txt', '1\n');
    commitAll(dir, 'feat: code 1');
    assert.equal(publish(dir, 'main', { mode: 'false' }).status, 0);
    const prelude = ghPrelude(repo, refOf(dir, 'refs/gsd/pr-built-head/default/main/feature'));
    const pub = git(dir, 'rev-parse', 'feature');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'other.txt', 'x\n');
    commitAll(dir, 'chore: unrelated');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'reset', '-q', '--hard', 'main');
    write(dir, '.planning/config.json', '{"x":1}\n');
    commitAll(dir, 'chore: config');
    git(dir, 'cherry-pick', pub);
    write(dir, 'two.txt', '2\n');
    commitAll(dir, 'feat: two');
    const r = publish(dir, 'main', { mode: 'false', prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.deepEqual(changed(dir), ['two.txt']);
  });

  // `main^{tree}` names a tree: only a commit can be a target.
  for (const target of ['nosuch', 'main^{tree}']) {
    test(`an unknown target (${target}) stops the run with exit 1 and changes no ref`, () => {
      const dir = repo();
      commitRound(dir, 1);
      const r = publish(dir, target);
      assert.equal(r.status, 1);
      assert.ok(r.stderr.includes(`Unknown target: ${target}`), r.stderr);
      assert.doesNotMatch(r.stderr, /fatal:|Cannot list/, 'the run stopped at the lookup, not at a later step');
      noRefs(dir);
    });
  }

  test('a failed pick-list lookup stops the run with exit 1 and changes no ref', () => {
    const dir = repo();
    commitRound(dir, 1);
    const r = publish(dir, 'main', { arms: '*"rev-list --reverse"*) return 1 ;;' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Cannot list the commits to pick; re-run\./);
    noRefs(dir);
  });

  test('a -pr branch that cannot be created stops the run with exit 1 and records nothing', () => {
    const dir = repo();
    commitRound(dir, 1);
    // Add a file, drop it, add another: replaying these on `feature` itself would add commits there.
    write(dir, 'x.txt', 'x\n');
    commitAll(dir, 'feat: add x');
    git(dir, 'rm', '-q', 'x.txt');
    commitAll(dir, 'feat: drop x');
    write(dir, 'y.txt', 'y\n');
    commitAll(dir, 'feat: add y');
    const commits = git(dir, 'rev-list', '--count', 'feature');
    git(dir, 'update-ref', 'refs/heads/feature-pr/x', 'main'); // a ref below the name blocks the branch
    const r = publish(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not create feature-pr from main/);
    assert.equal(git(dir, 'rev-list', '--count', 'feature'), commits, 'the run did not go on to replay commits onto feature');
    assert.equal(git(dir, 'for-each-ref', 'refs/gsd'), '');
  });

  test('a timed-out ancestor check of the marker stops the run with exit 1 instead of reading it as a rewrite', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    mergePr(dir);
    commitRound(dir, 2, 'two.txt');
    const before = refsOf(dir);
    const r = publish(dir, 'main', { arms: '*--is-ancestor*" refs/heads/feature") return 124 ;;' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Cannot check refs\/gsd\/pr-published\/strict\/main\/feature; re-run\./);
    assert.doesNotMatch(r.stderr, /history rewritten/);
    assert.deepEqual(refsOf(dir), before);
  });

  // A path list cut short by a timeout must not prove the merge.
  test('pr_merged: a --name-only list cut short by a timeout is not a content proof', () => {
    const dir = repo();
    write(dir, 'a.txt', 'a\n');
    write(dir, 'b.txt', 'b\n');
    commitAll(dir, 'feat: a and b');
    git(dir, 'branch', 'feature-pr', 'feature');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'a.txt', 'a\n');
    commitAll(dir, 'feat: only a');
    git(dir, 'checkout', '-q', 'feature');
    const stub = 'gsd_run() { shift 3; case "$*" in *--name-only*-z*) printf \'a.txt\\0\'; return 124 ;; esac; "$@"; }';
    assert.equal(probePrMerged(dir, `${stub}\ngh() { return 1; }`), 'UNMERGED');
  });
});
