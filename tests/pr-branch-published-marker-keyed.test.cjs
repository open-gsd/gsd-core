'use strict';

/**
 * #5469 — /gsd-pr-branch repeat publishes, part 3 of 6: markers keyed by mode, target and branch, publishes that build nothing and the pr_merged probes.
 * Runs the shipped bash blocks against real git fixtures; the shared fixtures are in
 * `tests/helpers/pr-branch-published-fixture.cjs`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { refOf } = require('./helpers/isolated-env.cjs');
const { readWorkflowText, extractDeclarationLines } = require('./helpers/pr-branch-filter.cjs');
const { MARKER, git, refkeyFn, commitAll, write, commitRound, publish, runSh, mergePr, probePrMerged, markerOf, builtOf, replayed, squashMerge, onlyRound2, ghPrelude, useRepos } = require('./helpers/pr-branch-published-fixture.cjs');

describe('#5469 pr-branch published marker (real git): keyed', () => {
  const repo = useRepos();

  test('markers are keyed by target: a release run does not anchor a main run', () => {
    const dir = repo();
    git(dir, 'branch', 'release', 'main');
    commitRound(dir, 1);
    assert.equal(publish(dir, 'release').status, 0);
    mergePr(dir, 'release');
    commitRound(dir, 2);
    assert.equal(publish(dir, 'release').status, 0);
    const releaseMarker = refOf(dir, 'refs/gsd/pr-published/strict/release/feature');
    assert.ok(releaseMarker, 'release marker promoted');
    git(dir, 'branch', '-D', 'feature-pr');
    const r = publish(dir, 'main');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(replayed(dir), ['r1.txt', 'r2.txt']);
    assert.equal(markerOf(dir), '');
    assert.equal(refOf(dir, 'refs/gsd/pr-published/strict/release/feature'), releaseMarker);
  });

  test('target merged into the feature branch after a publish: teammate commits are not picked', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge pr', 'feature-pr');
    for (const n of [1, 2]) { write(dir, 'o.txt', `teammate${n}\n`); commitAll(dir, `chore: teammate${n}`); }
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'merge', '-q', '--no-edit', 'main');
    commitRound(dir, 2);
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(replayed(dir), ['r2.txt']);
    assert.equal(git(dir, 'show', 'feature-pr:code.txt'), 'v2');
  });

  // The recorded tip is an ancestor of the branch, and the target already holds the whole branch.
  test('a branch the target already holds has nothing to filter: no -pr branch is built', () => {
    const dir = repo();
    commitRound(dir, 1);
    git(dir, 'update-ref', MARKER, 'feature~1');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--ff-only', 'feature');
    git(dir, 'checkout', '-q', 'feature');
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(refOf(dir, 'refs/heads/feature-pr'), '', 'no -pr branch was built');
    const rwt = fs.readFileSync(path.join(dir, '.git', 'rwt.log'), 'utf-8');
    assert.ok(splitLines(rwt).some((l) => l.startsWith('run-with-timeout 10 -- git rev-list --count refs/heads/feature --not')), `the count ran bounded (10 s):\n${rwt}`);
  });

  test('-pr rebased before merge: merged branch tip still promotes the marker', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const tip1 = git(dir, 'rev-parse', 'feature');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'other.txt', 'x\n');
    commitAll(dir, 'chore: unrelated');
    git(dir, 'rebase', '-q', 'main', 'feature-pr');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge pr', 'feature-pr');
    git(dir, 'checkout', '-q', 'feature');
    commitRound(dir, 2);
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(replayed(dir), ['r2.txt']);
    assert.equal(markerOf(dir), tip1);
  });

  test('-pr reset to the target before merging: the built tip was never merged, so the marker does not advance and the build is replayed', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    git(dir, 'branch', '-f', 'feature-pr', 'main');
    commitRound(dir, 2);
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(markerOf(dir), '', 'an unmerged built tip must not be promoted by the reset branch verdict');
    assert.deepEqual(replayed(dir), ['r1.txt', 'r2.txt']);
  });

  test('pr_merged: the probe reads a merged -pr as MERGED (positive control for the UNMERGED probes)', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    mergePr(dir);
    assert.equal(probePrMerged(dir), 'MERGED');
  });

  // The -pr tip has the tree of its fork point and the target moved on: no changed path, so nothing is proven.
  test('pr_merged: a -pr tip that changes no path is not a proof, even where xargs runs nothing on empty input (BSD)', () => {
    const dir = repo();
    commitRound(dir, 1);
    git(dir, 'checkout', '-q', '-b', 'feature-pr', 'main');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'chore: empty tip');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'other.txt', 'x\n');
    commitAll(dir, 'chore: main moves on');
    git(dir, 'checkout', '-q', 'feature');
    const bsdXargs = 'xargs() { local first; if IFS= read -r -d "" first; then { printf "%s\\0" "$first"; cat; } | command xargs "$@"; fi; }';
    assert.equal(probePrMerged(dir, `gsd_run() { shift 3; "$@"; }\ngh() { return 1; }\n${bsdXargs}`), 'UNMERGED');
  });

  // A path git reads as magic pathspec syntax must be compared as a file name.
  test('pr_merged: a changed file named like a magic pathspec is compared by name', { skip: process.platform === 'win32' }, () => {
    const dir = repo();
    const magic = ':(top)z';
    git(dir, 'checkout', '-q', '-b', 'feature-pr', 'main');
    write(dir, magic, 'A\n');
    commitAll(dir, 'feat: add magic name');
    git(dir, 'checkout', '-q', 'main');
    write(dir, magic, 'B\n');
    commitAll(dir, 'chore: main adds the same name with other content');
    git(dir, 'checkout', '-q', 'feature');
    assert.equal(probePrMerged(dir), 'UNMERGED');
  });

  test('pr_merged: a failed root lookup proves nothing (the changed paths are root-relative)', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    squashMerge(dir);
    assert.equal(probePrMerged(dir), 'MERGED');
    const noRoot = 'gsd_run() { shift 3; case "$*" in *show-toplevel*) return 124 ;; esac; "$@"; }\ngh() { return 1; }';
    assert.equal(probePrMerged(dir, noRoot), 'UNMERGED');
  });

  test('pr_merged: a -pr tip that does not resolve is not merged, even when gh reports an empty head', () => {
    const dir = repo();
    commitRound(dir, 1);
    const pre = `gsd_run() { shift 3; "$@"; }\n${ghPrelude(repo, '')}`;
    assert.equal(probePrMerged(dir, pre), 'UNMERGED');
  });

  test('pr_merged judges an unmerged -pr unmerged from a repo subdirectory too (paths are root-relative)', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    assert.equal(probePrMerged(dir), 'UNMERGED');
    assert.equal(probePrMerged(path.join(dir, '.planning', 'phases')), 'UNMERGED');
  });

  test('-pr extended with a commit after the build, then squash-merged: the -pr still holds the built tip, so the build counts as published', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const tip1 = git(dir, 'rev-parse', 'feature');
    git(dir, 'checkout', '-q', 'feature-pr');
    write(dir, 'code.txt', 'v1-fixed\n');
    commitAll(dir, 'fix: review feedback');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'checkout', 'feature-pr', '--', 'code.txt', 'r1.txt');
    commitAll(dir, 'feat: squashed r1 with fix');
    git(dir, 'checkout', '-q', 'feature');
    commitRound(dir, 2, 'two.txt');
    onlyRound2(publish(dir), dir);
    assert.equal(markerOf(dir), tip1);
  });

  test('a TARGET git rejects in ref names (HEAD~3) still records the pending build', () => {
    const dir = repo();
    commitRound(dir, 1);
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'HEAD~3');
    assert.equal(r.status, 0, r.stderr);
    const key = runSh(`${refkeyFn()}\nrefkey 'HEAD~3'`, dir).stdout.trim();
    assert.equal(refOf(dir, `refs/gsd/pr-built/strict/${key}/feature`), git(dir, 'rev-parse', 'feature'));
  });

  test('refkey output is a valid ref component for hostile strings', () => {
    const dir = repo();
    const fn = refkeyFn();
    for (const s of ['HEAD~3', 'a b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a..b', 'a@{b', 'x.lock', '.x', 'x.', 'origin/main']) {
      const r = runSh(`${fn}\nrefkey '${s.replace(/'/g, "'\\''")}'`, dir);
      git(dir, 'check-ref-format', `refs/gsd/pr-built/strict/${r.stdout.trim()}/feature`);
    }
  });

  test('shq round-trips any string through eval (property)', () => {
    const [fn] = extractDeclarationLines(readWorkflowText(), 'shq() {', ['shq() {']);
    fc.assert(fc.property(fc.array(fc.stringMatching(/^[a' $;`\\()&"%/-]{1,6}$/), { minLength: 1, maxLength: 20 }), (inputs) => {
      const r = runSh(`${fn}\nwhile IFS= read -r l; do eval "printf '%s\\n' $(shq "$l")"; done < in.txt`, undefined, { 'in.txt': inputs.join('\n') + '\n' });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(splitLines(r.stdout).slice(0, inputs.length), inputs);
    }), { numRuns: 20 });
  });

  test('shq keeps an empty string as one empty argument', () => {
    const [fn] = extractDeclarationLines(readWorkflowText(), 'shq() {', ['shq() {']);
    const r = runSh(`${fn}\neval "set -- $(shq '')"; printf '%s' "$#"`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '1');
  });

  test('a gh shell function is never queried: it cannot be bounded, so the merge is not proven', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const prTip = builtOf(dir);
    squashMerge(dir, { later: true, deletePr: true });
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { gh: `: > .git/gh-called; echo ${prTip}` });
    assert.equal(r.status, 1, 'replaying r1 over main\'s later edit conflicts and halts');
    assert.ok(!fs.existsSync(path.join(dir, '.git', 'gh-called')), 'the function was never run');
    assert.equal(markerOf(dir), '');
  });
});
