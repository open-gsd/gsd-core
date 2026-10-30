'use strict';

/**
 * #5469 — /gsd:pr-branch repeat publishes: the published-marker ref
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
const { runHook } = require('./helpers/process-seam.cjs');
const { gitOrThrow, GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/git-fixture.cjs');
const { createFixture } = require('./fixtures/index.cjs');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  WORKFLOW_PATH,
  extractPickLoop,
  extractBashBlockContaining,
} = require('./helpers/pr-branch-filter.cjs');

const MARKER = 'refs/gsd/pr-published/strict/main/feature';
const PENDING = 'refs/gsd/pr-built/strict/main/feature';
const BUILT = 'refs/gsd/pr-built-head/strict/main/feature';

const ISOLATED_ENV = (home) => ({
  PATH: process.env.PATH,
  HOME: home,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});

function git(dir, ...args) {
  return gitOrThrow(args, { cwd: dir, env: ISOLATED_ENV(dir), timeoutMs: GIT_FIXTURE_TIMEOUT_MS }).trim();
}

function refkeyFn() {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  return extractBashBlockContaining(text, 'PR_BRANCH="${CURRENT_BRANCH}-pr"').match(/^refkey\(\) \{.*\}$/m)[0];
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
  const dir = createFixture({ prefix: 'gsd-prmarker-', git: true, planning: false, projectDoc: false });
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
function publish(dir, target = 'main', { branch = 'feature', mode = 'true', gh = 'return 1', prelude = '', afterPre = '' } = {}) {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  const b = (marker) => extractBashBlockContaining(text, marker);
  const script = [
    `CURRENT_BRANCH='${branch}'`,
    `TARGET=${target}`,
    // run-with-timeout <secs> -- cmd...: log the call, then exec cmd (the real verb bounds it; the log proves it was used).
    `gsd_run() { if [ "$1" = run-with-timeout ]; then echo "$*" >> .git/rwt.log; shift 3; "$@"; else echo ${mode}; fi; }`,
    prelude || `gh() { ${gh}; }`, // hermetic: no network lookup unless a test supplies one
    b('PR_BRANCH="${CURRENT_BRANCH}-pr"'),
    afterPre, // stands in for the outward steps (handle_sub_repos) that run between the preconditions and the build
    b('TRANSIENT_DIRS="phases'),
    b('FILTER_PATHS=$(for d'),
    b('git log --oneline'),
    b('# Create PR branch from target'),
    extractPickLoop(text),
    b('git checkout "$CURRENT_BRANCH"'),
    b('DIFF_PATHS=$(git diff'),
    b('git update-ref "$PENDING_REF"'),
  ].join('\n');
  return runSh(script, dir);
}

// Script goes through a temp file, not argv (Windows MSYS2 mis-parses long quote-heavy argv).
function runSh(script, cwd, interpreter = 'bash') {
  const tmp = createTempDir('gsd-prmarker-script-');
  try {
    const file = path.join(tmp, 'recipe.sh');
    fs.writeFileSync(file, script);
    const r = runHook(file, [], { interpreter, cwd, env: ISOLATED_ENV(cwd) });
    return { status: r.exitCode ?? 1, stdout: r.stdout, stderr: r.stderr };
  } finally { cleanup(tmp); }
}

// Fast-forward the bare target to the published -pr branch (a merged PR).
function mergePr(dir, target = 'main') {
  git(dir, 'merge-base', '--is-ancestor', target, 'feature-pr');
  git(dir, 'update-ref', `refs/heads/${target}`, 'refs/heads/feature-pr');
}

// The shipped pr_merged (and its _to helper), for calling it directly.
const prMergedFns = () => {
  const block = extractBashBlockContaining(fs.readFileSync(WORKFLOW_PATH, 'utf-8'), 'pr_merged() {');
  return [block.match(/^_to\(\) \{.*\}$/m), block.match(/^pr_merged\(\) \{[\s\S]*?^\}$/m)].filter(Boolean).map((m) => m[0]).join('\n');
};

// The command a refusal prints on its `  <label>: <cmd>` line, so tests run what a user would paste.
const printedCmd = (stderr, label) => {
  const line = stderr.split(/\r?\n/).find((l) => l.startsWith(`  ${label}: `));
  assert.ok(line, `no "${label}:" line in: ${stderr}`);
  return line.slice(label.length + 4);
};

const refOf = (dir, ref) => {
  try { return git(dir, 'rev-parse', '-q', '--verify', ref); } catch { return ''; }
};
const markerOf = (dir) => refOf(dir, MARKER);
const pendingOf = (dir) => refOf(dir, PENDING);
const builtOf = (dir) => refOf(dir, BUILT);
// Rounds whose code reached the -pr tree (state, not log text).
const replayed = (dir) => git(dir, 'diff', '--name-only', 'main', 'feature-pr').split(/\r?\n/).filter((f) => /^r\d+\.txt$/.test(f)).sort();

describe('#5469 pr-branch published marker (real git)', () => {
  const dirs = [];
  const repo = () => { const d = buildRepo(); dirs.push(d); return d; };
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
    assert.ok(!fs.existsSync(path.join(dir, 'OUTWARD')), 'refusal must precede handle_sub_repos');
  });

  test('refkey encodes control and non-ASCII bytes so the marker ref is valid and injective', (t) => {
    const fn = refkeyFn();
    const tmp = createTempDir('gsd-refkey-ctl-');
    t.after(() => cleanup(tmp));
    const key = (arg) => runSh(`${fn}\nrefkey ${arg}`, tmp).stdout;
    assert.equal(key(`"$(printf 'a\\tb')"`), 'a%09b');
    assert.equal(key(`"$(printf 'a\\001b\\177')"`), 'a%01b%7F');
    assert.equal(key(`"$(printf '\\303\\251')"`), '%C3%A9');
    assert.equal(key(`'a%09b'`), 'a%2509b');
    const ref = key(`"$(printf 'x\\037y')"`);
    git(tmp, 'check-ref-format', `refs/gsd/pr-published/default/${ref}/b`); // throws on an invalid ref
  });

  test('refkey is injective and never emits a slash (property)', () => {
    const fn = refkeyFn();
    const keys = (inputs) => {
      const tmp = createTempDir('gsd-refkey-');
      try {
        const f = path.join(tmp, 'in.txt');
        fs.writeFileSync(f, inputs.join('\n') + '\n');
        const r = runSh(`${fn}\nwhile IFS= read -r l; do refkey "$l"; echo; done < '${f.replace(/\\/g, '/')}'`, tmp);
        assert.equal(r.status, 0, r.stderr);
        return r.stdout.split(/\r?\n/).slice(0, inputs.length);
      } finally { cleanup(tmp); }
    };
    // Every class refkey encodes (`% / space ~^:?*[\ . @`, control, non-ASCII) plus the literals that spell an escape.
    const unit = fc.constantFrom('a', '%', '2', 'F', '/', '.', '@', ' ', '~', '^', ':', '?', '*', '[', '\\', '\x01', '\t', '\x1f', '\x7f', 'é');
    const part = fc.string({ unit, minLength: 1, maxLength: 6 });
    fc.assert(fc.property(fc.uniqueArray(part, { minLength: 2, maxLength: 40 }), (inputs) => {
      const out = keys(inputs);
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
    const before = [markerOf(dir), pendingOf(dir), builtOf(dir)];
    const r = publish(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /feature-pr exists and is not merged into main/);
    assert.deepEqual([markerOf(dir), pendingOf(dir), builtOf(dir)], before, 'a refused run changes no ref');
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
    const before = [refOf(dir, 'refs/heads/feature-pr'), markerOf(dir), pendingOf(dir), builtOf(dir)];
    const r = publish(dir);
    assert.notEqual(r.status, 0);
    assert.deepEqual([refOf(dir, 'refs/heads/feature-pr'), markerOf(dir), pendingOf(dir), builtOf(dir)], before);
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
    const cmd = printedCmd(refused.stderr, 'merged by squash/rebase');
    const recovered = runSh(cmd, dir);
    assert.equal(recovered.status, 0, `recovery command failed: ${recovered.stderr}`);
    const next = publish(dir);
    assert.doesNotMatch(next.stderr, /dropped the pending build/);
    onlyRound2(next, dir);
    assert.equal(git(dir, 'show', 'feature-pr:two.txt'), 'v2');
  });

  test('squash-merged and deleted -pr, files changed on main since: the merge is not proven: nothing is published', () => {
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

  test('gh reporting a different head sha does not promote: the merge is not proven: nothing is published', () => {
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
  test('executable gh on a host without `timeout`: the lookup runs through run-with-timeout and proves the merge', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const tip1 = git(dir, 'rev-parse', 'feature');
    const prTip = builtOf(dir);
    squashMerge(dir, { later: true, deletePr: true });
    commitRound(dir, 2, 'two.txt');
    const noTimeout = "command() { if [ \"$1\" = -v ] && [ \"$2\" = timeout ]; then return 1; fi; builtin command \"$@\"; }";
    const r = publish(dir, 'main', { prelude: `${ghPrelude(prTip)}\n${noTimeout}` });
    onlyRound2(r, dir);
    assert.equal(markerOf(dir), tip1);
    assert.match(fs.readFileSync(path.join(dir, '.git', 'rwt.log'), 'utf-8'), /^run-with-timeout 10 -- gh pr list/m, 'gh ran bounded');
  });

  test('renamed file, squash merge on main keeps old.txt: not proven, the merge is not proven: nothing is published (--no-renames)', () => {
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
    assert.ok(!git(dir, 'ls-tree', '-r', '--name-only', 'feature-pr').split(/\r?\n/).includes('old.txt'), 'the unproven rename round is replayed');
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
    assert.ok(markerOf(dir) === '' && pendingOf(dir));
    commitRound(dir, 2);
    const r = publish(dir, 'main', { mode: 'false' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(refOf(dir, 'refs/gsd/pr-built/default/main/feature'), git(dir, 'rev-parse', 'feature'), 'default mode keeps its own pending ref');
    assert.equal(refOf(dir, 'refs/gsd/pr-published/default/main/feature'), '');
    assert.ok(refOf(dir, 'refs/gsd/pr-built/strict/main/feature'), 'strict pending untouched');
  });

  test('branches feat and feat/sub both record markers (no ref is a directory prefix of another)', () => {
    const dir = repo();
    commitRound(dir, 1);
    git(dir, 'checkout', '-q', '-b', 'feat/sub');
    for (const branch of ['feature', 'feat/sub']) {
      git(dir, 'checkout', '-q', branch);
      const r = publish(dir, 'main', { branch });
      assert.equal(r.status, 0, r.stderr);
      git(dir, 'checkout', '-q', 'main');
      git(dir, 'branch', '-D', `${branch}-pr`);
    }
    assert.ok(refOf(dir, 'refs/gsd/pr-built/strict/main/feature'));
    assert.ok(refOf(dir, 'refs/gsd/pr-built/strict/main/feat%2Fsub'));
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

  test('a refused publish on a branch name with shell metacharacters leaves its refs untouched', () => {
    const branch = 'a;b$c';
    const dir = buildRepo(branch);
    dirs.push(dir);
    commitRound(dir, 1);
    assert.equal(publish(dir, 'main', { branch }).status, 0);
    const refs = ['pr-published', 'pr-built', 'pr-built-head'].map((k) => `refs/gsd/${k}/strict/main/${branch}`);
    const before = refs.map((ref) => refOf(dir, ref));
    const prTip = git(dir, 'rev-parse', `${branch}-pr`);
    commitRound(dir, 2);
    const r = publish(dir, 'main', { branch });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /a;b\$c-pr exists and is not merged into main/);
    assert.equal(git(dir, 'rev-parse', `${branch}-pr`), prTip, 'the refused publish leaves the -pr branch');
    assert.deepEqual(refs.map((ref) => refOf(dir, ref)), before);
    assert.ok(!fs.existsSync(path.join(dir, `${branch}-pr`)) && !fs.existsSync(path.join(dir, 'b$c-pr')), 'no file from the injected suffix');
    assert.equal(runSh(printedCmd(r.stderr, 'merged by squash/rebase'), dir).status, 0, 'the printed command runs as one command');
    assert.equal(refOf(dir, `refs/heads/${branch}-pr`), '', 'and deletes the -pr branch');
    assert.ok(!fs.existsSync(path.join(dir, 'b$c-pr')), 'no file from the injected suffix, after running it');
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

  test('pr_merged judges an unmerged -pr unmerged from a repo subdirectory too (paths are root-relative)', () => {
    const dir = repo();
    commitRound(dir, 1);
    assert.equal(publish(dir).status, 0);
    const probe = (cwd) => runSh(`TARGET=main PR_BRANCH=feature-pr PR_BASE=main\ngh() { return 1; }\n${prMergedFns()}\npr_merged feature-pr && echo MERGED || echo UNMERGED`, cwd).stdout.trim();
    assert.equal(probe(dir), 'UNMERGED');
    assert.equal(probe(path.join(dir, '.planning', 'phases')), 'UNMERGED');
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

  test('shq round-trips any string through eval (property)', (t) => {
    const fn = extractBashBlockContaining(fs.readFileSync(WORKFLOW_PATH, 'utf-8'), 'shq() {').match(/^shq\(\) \{.*\}$/m)[0];
    const tmp = createTempDir('gsd-shq-');
    t.after(() => cleanup(tmp));
    const f = path.join(tmp, 'in.txt');
    fc.assert(fc.property(fc.array(fc.stringMatching(/^[a' $;`\\()&"%/-]{1,6}$/), { minLength: 1, maxLength: 20 }), (inputs) => {
      fs.writeFileSync(f, inputs.join('\n') + '\n');
      const r = runSh(`${fn}\nwhile IFS= read -r l; do eval "printf '%s\\n' $(shq "$l")"; done < '${f.replace(/\\/g, '/')}'`, tmp);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.stdout.split(/\r?\n/).slice(0, inputs.length), inputs);
    }), { numRuns: 20 });
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
    const before = [markerOf(dir), pendingOf(dir), builtOf(dir)];
    const r = publish(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Working tree has uncommitted changes/);
    assert.deepEqual([markerOf(dir), pendingOf(dir), builtOf(dir)], before, 'a refused run changes no ref');
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
    const before = [markerOf(dir), pendingOf(dir), builtOf(dir)];
    const r = publish(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /feature-pr exists and is not merged into main/);
    assert.deepEqual([markerOf(dir), pendingOf(dir), builtOf(dir)], before, 'a refused run changes no ref');
    const printed = r.stderr.split(/\r?\n/).filter((l) => l.includes('discard:')).map((l) => l.split('discard: ')[1]);
    assert.deepEqual(printed, ['git branch -D feature-pr'], 'the build is proven merged, so the menu must not offer to forget it');
    assert.equal(runSh(printed[0], dir).status, 0);
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
      const before = [markerOf(dir), pendingOf(dir), builtOf(dir), refOf(dir, 'refs/heads/feature-pr')];
      const r = publish(dir);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /feature-pr is merged into main but no longer holds the pending build/);
      assert.deepEqual([markerOf(dir), pendingOf(dir), builtOf(dir), refOf(dir, 'refs/heads/feature-pr')], before, 'a refused run changes nothing');
      const printed = r.stderr.split(/\r?\n/).find((l) => l.includes('merged by squash/rebase:')).split('merged by squash/rebase: ')[1];
      assert.equal(runSh(printed, dir).status, 0, 'the printed re-anchor command runs');
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
  const changed = (dir) => git(dir, 'diff', '--name-only', 'main', 'feature-pr').split(/\r?\n/).sort();
  const WARNED = /not an ancestor of feature/;

  test('rebased working branch after a published round: the patch-equivalent commit is the base; nothing is replayed, no warning', () => {
    const { dir, prelude } = publishedWhileMainMoves();
    git(dir, 'rebase', '-q', 'main');
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, WARNED);
    assert.deepEqual(changed(dir), ['other.txt'.slice(0,0)+'r2.txt', 'two.txt'].filter(Boolean));
  });

  test('rebased working branch with an unpublished commit reordered below the published tip: warns and uses the target', () => {
    const { dir, prelude } = publishedWhileMainMoves();
    write(dir, 'u.txt', 'u\n');
    commitAll(dir, 'feat: unpublished');
    const [c1, d1, u] = git(dir, 'log', '--reverse', '--format=%H', 'feature', '--not', 'main').split(/\r?\n/);
    git(dir, 'checkout', '-q', '-B', 'tmp', 'main');
    git(dir, 'cherry-pick', c1, u, d1);
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

  test('pr_merged ignores diff.relative: an unmerged -pr stays unmerged when judged from the subdirectory it changed', () => {
    const dir = repo();
    write(dir, 'lib/a.txt', 'a\n');
    commitAll(dir, 'feat: lib');
    git(dir, 'branch', 'feature-pr', 'feature');
    git(dir, 'config', 'diff.relative', 'true');
    const probe = runSh(`TARGET=main PR_BRANCH=feature-pr PR_BASE=main\ngh() { return 1; }\n${prMergedFns()}\npr_merged feature-pr && echo MERGED || echo UNMERGED`, path.join(dir, 'lib')).stdout.trim();
    assert.equal(probe, 'UNMERGED');
  });

  test('rebased working branch whose newest published commit was conflict-resolved (changed patch): warns, never replays it silently', () => {
    const { dir, prelude } = publishedWhileMainMoves();
    git(dir, 'checkout', '-q', 'main');
    write(dir, '.planning/STATE.md', 's-main\n');
    commitAll(dir, 'chore: main edits state');
    git(dir, 'checkout', '-q', 'feature');
    const rb = runSh("git rebase -q main || { printf 's-resolved\\n' > .planning/STATE.md; git add -A; git -c core.editor=true rebase --continue; }", dir);
    assert.equal(rb.status, 0, rb.stderr);
    commitRound(dir, 2, 'two.txt');
    const r = publish(dir, 'main', { prelude });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, WARNED);
  });
});
