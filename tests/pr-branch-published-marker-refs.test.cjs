'use strict';

/**
 * #5469 — /gsd-pr-branch repeat publishes, part 1 of 6: the recorded refs: round replay, refusals, quiet ref lookups and ref keys.
 * Runs the shipped bash blocks against real git fixtures; the shared fixtures are in
 * `tests/helpers/pr-branch-published-fixture.cjs`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');
const { refOf } = require('./helpers/isolated-env.cjs');
const { createTempDir } = require('./helpers.cjs');
const { BUILT, HOSTILE, git, refkeyFn, commitAll, write, commitRound, publish, runSh, refKeys, mergePr, printedCmd, markerOf, pendingOf, builtOf, refsOf, replayed, useRepos } = require('./helpers/pr-branch-published-fixture.cjs');

describe('#5469 pr-branch published marker (real git): refs', () => {
  const repo = useRepos();

  test('round 3 replays only the round-3 commits; marker follows the tip; merged leftover -pr is replaced', () => {
    const dir = repo();
    let prevTip = '';
    for (const n of [1, 2, 3]) {
      commitRound(dir, n);
      const tip = git(dir, 'rev-parse', 'feature');
      const r = publish(dir);
      assert.equal(r.status, 0, `round ${n} failed: ${r.stderr}`);
      assert.deepEqual(replayed(dir), [`r${n}.txt`], `round ${n} must carry only its own code`);
      assert.equal(git(dir, 'rev-list', '--count', 'main..feature-pr'), '1');
      assert.equal(pendingOf(dir), tip, 'build records the TIP captured at start as pending');
      assert.equal(builtOf(dir), git(dir, 'rev-parse', 'feature-pr'), 'build records the -pr tip beside pending');
      assert.equal(markerOf(dir), n === 1 ? '' : prevTip, 'marker is promoted only after the PR branch is merged');
      mergePr(dir);
      prevTip = tip;
    }
  });

  test('refusing a leftover unmerged -pr runs before any outward step', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    commitRound(dir, 2);
    const r = publish(dir, 'main', { afterPre: 'touch OUTWARD' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /feature-pr exists and is not merged into main/);
    assert.ok(!fs.existsSync(path.join(dir, 'OUTWARD')), 'refusal must precede handle_sub_repos');
  });

  test('a KEEP left over from an earlier run does not stop the pending build from being recorded', () => {
    const dir = repo();
    commitRound(dir, 1);
    const r = publish(dir, 'main', { prelude: 'KEEP=1\ngh() { return 1; }' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(pendingOf(dir), git(dir, 'rev-parse', 'feature'));
  });

  test('a first publish prints no git error (the ref lookups are quiet)', () => {
    const dir = repo();
    commitRound(dir, 1);
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /fatal:|error:/);
  });

  test('a pending build without a built-head ref is read quietly', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    git(dir, 'update-ref', '-d', BUILT);
    git(dir, 'branch', '-D', 'feature-pr');
    commitRound(dir, 2);
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /fatal:|error:/);
  });

  test('a tag named like the working branch is not read as that branch', () => {
    const dir = repo();
    commitRound(dir, 1);
    git(dir, 'tag', 'feature', 'feature~2'); // an older commit under the branch name
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(pendingOf(dir), git(dir, 'rev-parse', 'refs/heads/feature'), 'the pending build is the branch tip, not the tag');
    assert.equal(git(dir, 'show', 'refs/heads/feature-pr:two.txt'), 'v2', 'both rounds were built');
  });

  test('a tag named like the target branch is not read as that branch', () => {
    const dir = repo();
    commitRound(dir, 1);
    git(dir, 'tag', 'main', 'feature'); // the tag names the working branch's tip, so the target would hold all of it
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'show', 'refs/heads/feature-pr:r1.txt'), 'round 1', 'the -pr branch was built on the target branch');
  });

  test('a tag named like the -pr branch is not read as that branch', () => {
    const dir = repo();
    commitRound(dir, 1);
    git(dir, 'tag', 'feature-pr', 'feature'); // a tag on unmerged work: read as the -pr branch it would refuse the run
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(dir, 'show', 'refs/heads/feature-pr:r1.txt'), 'round 1', 'the branch was built, the tag is not its tip');
    assert.equal(builtOf(dir), git(dir, 'rev-parse', 'refs/heads/feature-pr'), 'the built-head ref is the branch tip, not the tag');
  });

  test('refkey encodes control and non-ASCII bytes so the marker ref is valid and injective', () => {
    const fn = refkeyFn();
    const tmp = createTempDir('gsd-refkey-ctl-');
    repo.keep(tmp);
    const key = (arg) => runSh(`${fn}\nrefkey ${arg}`, tmp).stdout;
    assert.equal(key(`"$(printf 'a\\tb')"`), 'a%09b');
    assert.equal(key(`"$(printf 'a\\001b\\177')"`), 'a%01b%7F');
    assert.equal(key(`"$(printf '\\303\\251')"`), '%C3%A9');
    assert.equal(key(`'a%09b'`), 'a%2509b');
    const ref = key(`"$(printf 'x\\037y')"`);
    git(tmp, 'check-ref-format', `refs/gsd/pr-published/default/${ref}/b`); // throws on an invalid ref
  });

  test('refkey keeps a long run of one byte whole (od prints every line)', () => {
    const names = [31, 32, 33, 48, 64].map((n) => 'a'.repeat(n)); // od collapses repeated 16-byte lines from 32 identical bytes
    assert.deepEqual(refKeys(refkeyFn(), names), names);
  });

  test('refkey is injective and never emits a slash (property)', () => {
    const fn = refkeyFn();
    // Every class refkey encodes (`% / space ~^:?*[\ . @`, control, non-ASCII) plus the literals that spell an escape.
    const unit = fc.constantFrom('a', '%', '2', 'F', '/', '.', '@', ' ', '~', '^', ':', '?', '*', '[', '\\', '\x01', '\t', '\x1f', '\x7f', 'é');
    const part = fc.string({ unit, minLength: 1, maxLength: 6 });
    fc.assert(fc.property(fc.uniqueArray(part, { minLength: 2, maxLength: 40 }), (inputs) => {
      const out = refKeys(fn, inputs);
      assert.equal(new Set(out).size, inputs.length, 'distinct inputs must give distinct keys');
      assert.ok(out.every((k) => !k.includes('/')));
    }), { numRuns: 20 });
  });

  test('leftover UNmerged -pr is refused with a message naming it, and left intact', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const prTip = git(dir, 'rev-parse', 'feature-pr');
    commitRound(dir, 2);
    const before = refsOf(dir);
    const r = publish(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /feature-pr exists and is not merged into main/);
    assert.deepEqual(refsOf(dir), before, 'a refused run changes no ref');
    assert.equal(git(dir, 'rev-parse', 'feature-pr'), prTip);
    assert.equal(git(dir, 'branch', '--show-current'), 'feature');
    // A deliberate discard must also drop the pending build.
    const discard = printedCmd(r.stderr, 'discard');
    assert.equal(runSh(discard, dir).status, 0);
    const next = publish(dir);
    assert.equal(next.status, 0, next.stderr);
  });

  test('reworded tip after the round merged: the equal patch is the base, so no warning and nothing extra is replayed', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    mergePr(dir);
    // Rewrite history: reword the tip so the marker is no longer an ancestor.
    git(dir, 'commit', '-q', '--amend', '-m', 'docs: r1 reworded');
    commitRound(dir, 2);
    const pendingBefore = pendingOf(dir);
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /not an ancestor/);
    assert.equal(markerOf(dir), pendingBefore, 'the merged round-1 build is promoted to the marker');
    assert.equal(git(dir, 'show', 'feature-pr:code.txt'), 'v2');
    assert.equal(pendingOf(dir), git(dir, 'rev-parse', 'feature'));
  });

  test('a conflict halt that cannot return to the branch prints a restore command that runs for a name with shell metacharacters', () => {
    const branch = HOSTILE;
    const dir = repo(branch);
    commitRound(dir, 1);
    assert.equal(publish(dir, 'main', { branch }).status, 0);
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge pr', `${branch}-pr`);
    write(dir, 'code.txt', 'main-diverged\n');
    commitAll(dir, 'chore: main diverges');
    git(dir, 'checkout', '-q', branch);
    commitRound(dir, 2);
    // the checkout back to the working branch fails; every other git call runs as usual
    const noReturn = `gh() { return 1; }\ngit() { if [ "$1" = checkout ] && [ "$2" = -q ] && [ "$3" = "${HOSTILE.replace('$', '\\$')}" ]; then return 1; fi; command git "$@"; }`;
    const r = publish(dir, 'main', { branch, prelude: noReturn });
    assert.notEqual(r.status, 0, 'conflict must halt');
    const m = r.stderr.match(/^Run: (git checkout .*)$/m);
    assert.ok(m, r.stderr);
    assert.equal(runSh(m[1], dir).status, 0, 'the printed command runs as one command');
    assert.equal(refOf(dir, `refs/heads/${branch}-pr`), '', 'and deletes the partial -pr branch');
    assert.equal(git(dir, 'branch', '--show-current'), branch);
  });

  test('marker does not advance when a conflict halts the run', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const m1 = git(dir, 'rev-parse', 'feature');
    assert.equal(pendingOf(dir), m1, 'round 1 must record the pending tip');
    mergePr(dir);
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'code.txt', 'main-diverged\n');
    commitAll(dir, 'chore: main diverges');
    git(dir, 'checkout', '-q', 'feature');
    commitRound(dir, 2);
    const r = publish(dir);
    assert.notEqual(r.status, 0, 'conflict must halt');
    assert.equal(markerOf(dir), m1, 'marker is the merged round-1 tip');
    assert.equal(pendingOf(dir), '', 'failed round 2 must not record a pending tip');
  });

  test('discarded -pr branch: unpublished commits are replayed, pending is dropped', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    git(dir, 'branch', '-D', 'feature-pr');
    commitRound(dir, 2);
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(replayed(dir), ['r1.txt', 'r2.txt']);
    assert.equal(markerOf(dir), '', 'nothing was published');
    assert.equal(pendingOf(dir), git(dir, 'rev-parse', 'feature'));
  });

  test('a dropped pending build leaves neither its refs behind, even when the run stops right after', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    assert.notEqual(builtOf(dir), '', 'the first run recorded the built head');
    git(dir, 'branch', '-D', 'feature-pr');
    commitRound(dir, 2);
    const stop = '*"rev-list --reverse"*) return 1 ;;';
    assert.equal(publish(dir, 'main', { arms: stop }).status, 1);
    assert.equal(pendingOf(dir), '');
    assert.equal(builtOf(dir), '');
  });

  test('merged then locally deleted -pr: pending is promoted, nothing replayed', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const tip1 = git(dir, 'rev-parse', 'feature');
    mergePr(dir);
    git(dir, 'branch', '-D', 'feature-pr');
    commitRound(dir, 2);
    const r = publish(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(markerOf(dir), tip1, 'merged build is promoted despite the deleted -pr branch');
    assert.deepEqual(replayed(dir), ['r2.txt']);
  });

  test('refusal without a pending ref leaves every ref untouched', () => {
    const dir = repo();
    git(dir, 'checkout', '-q', '-b', 'feature-pr', 'main');
    write(dir, 'other.txt', 'x\n');
    commitAll(dir, 'chore: stray');
    git(dir, 'checkout', '-q', 'feature');
    commitRound(dir, 1);
    const before = refsOf(dir);
    const r = publish(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /feature-pr exists and is not merged into main/);
    assert.deepEqual(refsOf(dir), before);
  });
});
