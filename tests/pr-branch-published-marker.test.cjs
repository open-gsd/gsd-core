'use strict';

/**
 * #5469 — /gsd-pr-branch repeat publishes: the published-marker ref
 * (`refs/gsd/pr-published/<mode>/<target>/<branch>`, promoted from the pending build refs once the
 * `-pr` branch merges) bounds the commit range, and a leftover `<branch>-pr` is replaced when
 * merged / refused when not.
 *
 * L2 only: runs the SHIPPED bash blocks of `gsd-core/workflows/pr-branch.md`
 * (pr-branch-filter seam) in order against real git fixtures.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { cleanup, createTempDir } = require('./helpers.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { createFixture } = require('./fixtures/index.cjs');
const fc = require('./helpers/fast-check-setup.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { gitChildEnv, gitIn, refOf } = require('./helpers/isolated-env.cjs');

const {
  readWorkflowText,
  extractPickLoop,
  extractBashBlockContaining,
  extractDeclarationLines,
  extractFunction,
  runBashFile,
  TRANSIENT_DIRS_MARKER,
  FILTER_PATHS_MARKER,
  PRECONDITIONS_MARKER,
} = require('./helpers/pr-branch-filter.cjs');

const MARKER = 'refs/gsd/pr-published/strict/main/feature';
const PENDING = 'refs/gsd/pr-built/strict/main/feature';
const BUILT = 'refs/gsd/pr-built-head/strict/main/feature';
const HOSTILE = 'a;b$c'; // a branch name that holds shell metacharacters

function git(dir, ...args) {
  return gitIn(dir)(args).trim();
}

function refkeyFn() {
  const text = readWorkflowText();
  return extractDeclarationLines(text, PRECONDITIONS_MARKER, ['refkey() {'])[0];
}

function commitAll(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function buildRepo(branch = 'feature') {
  const dir = createFixture({ prefix: 'gsd-prmarker-', git: true, planning: false, projectDoc: false, gitEnv: gitChildEnv });
  git(dir, 'branch', '-M', 'main');
  write(dir, 'code.txt', 'v0\n');
  write(dir, '.planning/STATE.md', 's0\n');
  commitAll(dir, 'chore: base');
  git(dir, 'checkout', '-q', '-b', branch);
  return dir;
}

// One code+planning commit and one planning-only commit, both tagged rN.
function commitRound(dir, n, file = 'code.txt') {
  write(dir, file, `v${n}\n`);
  write(dir, `r${n}.txt`, `round ${n}\n`); // the replayed rounds are read off the -pr tree
  write(dir, `.planning/phases/r${n}.md`, `plan ${n}\n`);
  commitAll(dir, `feat: r${n}`);
  write(dir, '.planning/STATE.md', `s${n}\n`);
  commitAll(dir, `docs: r${n}`);
}

// Runs the shipped blocks in workflow order under pr_strict.
function publish(dir, target = 'main', { branch = 'feature', mode = 'true', gh = 'return 1', prelude = '', arms = '', afterPre = '', cwd = dir } = {}) {
  const text = readWorkflowText();
  const b = (marker) => extractBashBlockContaining(text, marker);
  const script = [
    `CURRENT_BRANCH='${branch}'`,
    `TARGET=${target}`,
    // run-with-timeout <secs> -- cmd...: log the call, then exec cmd (the real verb bounds it; the log proves it was used).
    // `arms` are case arms matched against the command (after the bound), to make one call fail, time out or lose output.
    `gsd_run() { if [ "$1" = run-with-timeout ]; then echo "$*" >> .git/rwt.log; shift 3; case "$*" in ${arms} esac; "$@"; else echo ${mode}; fi; }`,
    prelude || `gh() { ${gh}; }`, // hermetic: no network lookup unless a test supplies one
    b('PR_STRICT=$(gsd_run query config-get'), // the mode and the filter projections come first; the preconditions read them
    b(TRANSIENT_DIRS_MARKER),
    b(FILTER_PATHS_MARKER),
    b(PRECONDITIONS_MARKER),
    afterPre, // stands in for the outward steps (handle_sub_repos) that run between the preconditions and the build
    b('git log --oneline'),
    b('# Create PR branch from target'),
    extractPickLoop(text),
    b('git checkout "$CURRENT_BRANCH"'),
    b('{ DIFF_PATHS=$('),
    b('git update-ref "$PENDING_REF"'),
  ].join('\n');
  return runSh(script, cwd);
}

// `status` is null for a killed or timed-out run, so a fail-closed test cannot pass on one. Without `cwd` the script
// runs in the dir that holds `files` (name -> content).
function runSh(script, cwd, files) {
  return toLegacyResult(runBashFile(script, { prefix: 'gsd-prmarker-script-', cwd, files, env: (dir) => gitChildEnv(cwd ?? dir) }));
}

// Keys for `inputs`, one per line, through the shipped refkey function `fn`.
const refKeys = (fn, inputs) => {
  const r = runSh(`${fn}\nwhile IFS= read -r l; do refkey "$l"; echo; done < in.txt`, undefined, { 'in.txt': inputs.join('\n') + '\n' });
  assert.equal(r.status, 0, r.stderr);
  return splitLines(r.stdout).slice(0, inputs.length);
};

// Fast-forward the bare target to the published -pr branch (a merged PR).
function mergePr(dir, target = 'main') {
  git(dir, 'merge-base', '--is-ancestor', target, 'feature-pr');
  git(dir, 'update-ref', `refs/heads/${target}`, 'refs/heads/feature-pr');
}

// The shipped pr_merged (and its _to helper), for calling it directly.
const prMergedFns = () => {
  const text = readWorkflowText();
  const [toFn] = extractDeclarationLines(text, 'pr_merged() {', ['_to() {']);
  return [toFn, extractFunction(text, 'pr_merged() {', 'pr_merged')].join('\n');
};

// Runs the shipped pr_merged on feature-pr in `cwd`: MERGED or UNMERGED. `pre` stubs gh and gsd_run (the default runs
// the command unbounded: without a gsd_run every `_to` call fails and any probe reads UNMERGED).
const probePrMerged = (cwd, pre = 'gsd_run() { shift 3; "$@"; }\ngh() { return 1; }') => {
  const r = runSh(`TARGET=main TARGET_SHA=main PR_BRANCH=feature-pr PR_BASE=main\n${pre}\n${prMergedFns()}\npr_merged feature-pr && echo MERGED || echo UNMERGED`, cwd);
  assert.doesNotMatch(r.stderr, /fatal: Needed a single revision/, 'the ref lookups of pr_merged are quiet');
  return r.stdout.trim();
};

// The command a refusal prints on its `  <label>: <cmd>` line, so tests run what a user would paste.
const printedCmd = (stderr, label) => {
  const line = splitLines(stderr).find((l) => l.startsWith(`  ${label}: `));
  assert.ok(line, `no "${label}:" line in: ${stderr}`);
  return line.slice(label.length + 4);
};

const markerOf = (dir) => refOf(dir, MARKER);
const pendingOf = (dir) => refOf(dir, PENDING);
const builtOf = (dir) => refOf(dir, BUILT);
// The refs a run may change: the three recorded refs and the -pr branch.
const refsOf = (dir) => [markerOf(dir), pendingOf(dir), builtOf(dir), refOf(dir, 'refs/heads/feature-pr')];
// A rebase-merge of the published -pr onto a moved target: main gains an unrelated commit, then the -pr commits are cherry-picked.
const rebaseMergePr = (dir) => {
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'other.txt', 'x\n');
  commitAll(dir, 'chore: unrelated');
  git(dir, 'cherry-pick', ...splitLines(git(dir, 'log', '--reverse', '--format=%H', 'feature-pr', '--not', 'main~1')));
};
const changed = (dir) => splitLines(git(dir, 'diff', '--name-only', 'main', 'feature-pr')).sort();
// Rounds whose code reached the -pr tree (state, not log text).
const replayed = (dir) => changed(dir).filter((f) => /^r\d+\.txt$/.test(f));

describe('#5469 pr-branch published marker (real git)', () => {
  const dirs = [];
  const repo = (branch) => { const d = buildRepo(branch); dirs.push(d); return d; };
  const renameFixture = () => {
    const dir = repo();
    write(dir, 'old.txt', 'a\nb\nc\nd\ne\nf\n');
    commitAll(dir, 'chore: add old');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--ff-only', 'feature');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'mv', 'old.txt', 'new.txt');
    write(dir, 'code.txt', 'v1\n');
    commitAll(dir, 'feat: r1 rename');
    assert.equal(publish(dir).status, 0);
    return dir;
  };
  afterEach(() => { while (dirs.length) cleanup(dirs.pop()); });

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
    dirs.push(tmp);
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

  // main takes round 1's code as one new commit (squash merge); `later` then edits the same file.
  function squashMerge(dir, { later = false, deletePr = false } = {}) {
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'checkout', 'feature-pr', '--', 'code.txt', 'r1.txt');
    commitAll(dir, 'feat: squashed r1');
    if (later) { write(dir, 'code.txt', 'v1-edited\n'); commitAll(dir, 'chore: later edit'); }
    git(dir, 'checkout', '-q', 'feature');
    if (deletePr) git(dir, 'branch', '-D', 'feature-pr');
  }
  const onlyRound2 = (r, dir) => {
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(replayed(dir), ['r2.txt']);
  };

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

  // Executable gh on PATH (a shell function cannot be bounded, so pr_merged never queries one).
  const ghPrelude = (sha, base = 'main') => {
    const bin = createTempDir('gsd-prmarker-bin-');
    dirs.push(bin);
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n: > .git/gh-called\n[ "$*" = "pr list --state merged --head feature-pr --base ${base} --json headRefOid --jq .[].headRefOid" ] && echo ${sha}\n`, { mode: 0o755 });
    return `PATH="${bin.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)}:$PATH"`;
  };

  test('gh reporting a different head sha does not promote, so nothing is published', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const pendingBefore = pendingOf(dir);
    squashMerge(dir, { later: true, deletePr: true });
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { prelude: ghPrelude(git(dir, 'rev-parse', 'main')) });
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
    const r = publish(dir, 'main', { prelude: ghPrelude(prTip, 'release') });
    assert.equal(r.status, 1, 'replaying r1 over main\'s later edit conflicts and halts');
    assert.ok(fs.existsSync(path.join(dir, '.git', 'gh-called')), 'gh was queried, so the verdict is the sha filter\'s');
    assert.equal(markerOf(dir), '');
    assert.notEqual(pendingOf(dir), pendingBefore, 'the old pending build was dropped');
  });

  test('renamed file in the -pr diff: both sides are compared (--no-renames), squash merge still proven', () => {
    const dir = renameFixture();
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
    const r = publish(dir, 'main', { prelude: ghPrelude(prTip) });
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
    const r = publish(dir, 'main', { prelude: ghPrelude(prTip) });
    onlyRound2(r, dir);
    assert.equal(markerOf(dir), tip1);
    assert.match(fs.readFileSync(path.join(dir, '.git', 'rwt.log'), 'utf-8'), /^run-with-timeout 10 -- gh pr list/m, 'gh ran bounded');
  });

  test('renamed file, squash merge on main keeps old.txt: the merge is not proven, so nothing is published (--no-renames)', () => {
    const dir = renameFixture();
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
    const r = publish(dir, 'origin/main', { prelude: ghPrelude(prTip) });
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
    const pre = `gsd_run() { shift 3; "$@"; }\n${ghPrelude('')}`;
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

  // A -pr amended after the build (the built tip is no longer in it), merged by merge commit; `edit` then changes code.txt on main.
  const amendedMerged = (edit) => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const tip1 = git(dir, 'rev-parse', 'feature');
    git(dir, 'checkout', '-q', 'feature-pr');
    write(dir, 'code.txt', 'v1-fixed\n');
    git(dir, 'commit', '-q', '-a', '--amend', '-m', 'feat: r1 amended');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge pr', 'feature-pr');
    if (edit) { write(dir, edit.file, edit.text); commitAll(dir, 'chore: later target edit'); }
    git(dir, 'checkout', '-q', 'feature');
    commitRound(dir, 2, 'two.txt');
    return { dir, tip1 };
  };
  for (const [label, edit] of [['conflicting', { file: 'code.txt', text: 'v1-edited-later\n' }], ['non-conflicting', { file: 'other.txt', text: 'x\n' }]]) {
    test(`-pr amended after the build, merged, then a ${label} target edit: refused naming it; the printed re-anchor lets the next run replay only round 2`, () => {
      const { dir, tip1 } = amendedMerged(edit);
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

  // Round 1 published and reported merged by gh, so the marker is promoted on the next run; main moves on with an unrelated commit.
  function publishedWhileMainMoves() {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const prelude = ghPrelude(builtOf(dir));
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'other.txt', 'x\n');
    commitAll(dir, 'chore: unrelated');
    git(dir, 'checkout', '-q', 'feature');
    return { dir, prelude };
  }
  const WARNED = /not an ancestor of feature/;

  test('rebased working branch after a published round: the patch-equivalent commit is the base; nothing is replayed, no warning', () => {
    const { dir, prelude } = publishedWhileMainMoves();
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
    const { dir, prelude } = publishedWhileMainMoves();
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
      const { dir, prelude } = publishedWhileMainMoves();
      git(dir, 'rebase', '-q', 'main');
      commitRound(dir, 2, 'two.txt');
      const r = publish(dir, 'main', { prelude, arms: `${pattern}) return 1 ;;` });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, WARNED);
    });
  }

  test('a patch walk killed after partial output warns: the cut commit is not read as unpublished', () => {
    const { dir, prelude } = publishedWhileMainMoves();
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    // run-with-timeout cuts the last two lines off the patch walk (inside its oldest patch) and reports 124
    const cut = `*"log -p"*) "$@" | awk '{a[NR]=$0} END{for(i=1;i<=NR-2;i++)print a[i]}'; return 124 ;;`;
    const r = publish(dir, 'main', { prelude, arms: cut });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, WARNED);
  });

  test('a picked commit the patch-id run left out warns instead of being read as unpublished', () => {
    const { dir, prelude } = publishedWhileMainMoves();
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
    const { dir, prelude } = publishedWhileMainMoves();
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
    const { dir, prelude } = publishedWhileMainMoves();
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
    const prelude = ghPrelude(builtOf(dir));
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
    const { dir, prelude } = publishedWhileMainMoves();
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
    const { dir, prelude } = publishedWhileMainMoves();
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
    const { dir, prelude } = publishedWhileMainMoves();
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
    const { dir, prelude } = publishedWhileMainMoves();
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    git(dir, 'config', 'color.ui', 'always');
    const r = publish(dir, 'main', { prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.deepEqual(changed(dir), ['r2.txt', 'two.txt']);
  });

  test('color.diff=always: the rebased round still matches its published patch; only round 2 is replayed', () => {
    const { dir, prelude } = publishedWhileMainMoves();
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    git(dir, 'config', 'color.diff', 'always');
    const r = publish(dir, 'main', { prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.deepEqual(changed(dir), ['r2.txt', 'two.txt']);
  });

  test('diff.relative=true, run from .planning/phases: the rebased round still matches; only round 2 is replayed', () => {
    const { dir, prelude } = publishedWhileMainMoves();
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    git(dir, 'config', 'diff.relative', 'true');
    const r = publish(dir, 'main', { prelude, cwd: path.join(dir, '.planning', 'phases') });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.deepEqual(changed(dir), ['r2.txt', 'two.txt']);
  });

  // Root files named like the matcher's old section markers.
  test('files named L, R, D, F, P and `commit <sha>` do not shift the matcher sections', () => {
    const dir = repo();
    for (const f of ['L', 'R', 'D', 'F', 'P', `commit ${'a'.repeat(40)}`]) write(dir, f, `${f}\n`);
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const prelude = ghPrelude(builtOf(dir));
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
    const r = publish(dir, 'main', { prelude: ghPrelude(`${builtOf(dir)}0`) });
    assert.equal(r.status, 1, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, '.git', 'gh-called')), 'gh was queried');
    assert.equal(markerOf(dir), '');
    assert.notEqual(pendingOf(dir), pendingBefore, 'the old pending build was dropped');
  });

  // An unpublished commit whose committer date is older than the rebased published copy; only --topo-order keeps the order.
  test('rebased branch with a clock-skewed unpublished commit on top: the published copy is still the base', () => {
    const { dir, prelude } = publishedWhileMainMoves();
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
    dirs.push(out);
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
    const prelude = ghPrelude(refOf(dir, 'refs/gsd/pr-built-head/default/main/feature'));
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

  // Each new exit 1 path prints its message and changes no ref.
  const noRefs = (dir) => {
    assert.equal(git(dir, 'for-each-ref', 'refs/gsd'), '');
    assert.equal(refOf(dir, 'refs/heads/feature-pr'), '');
  };

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
