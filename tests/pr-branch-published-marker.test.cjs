'use strict';

/**
 * #5469 — /gsd:pr-branch repeat publishes: the published-marker ref
 * (`refs/gsd/pr-published/<target>/<branch>`, promoted from the pending build refs once the
 * `-pr` branch merges) bounds the commit range, and a leftover `<branch>-pr` is replaced when
 * merged / refused when not.
 *
 * L2 only: runs the SHIPPED bash blocks of `gsd-core/workflows/pr-branch.md`
 * (pr-branch-filter seam) in order against real git fixtures.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { cleanup } = require('./helpers.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const {
  WORKFLOW_PATH,
  extractPickLoop,
  extractBashBlockContaining,
} = require('./helpers/pr-branch-filter.cjs');

const MARKER = 'refs/gsd/pr-published/main/feature';
const PENDING = 'refs/gsd/pr-built/main/feature';
const BUILT = 'refs/gsd/pr-built-head/main/feature';

const ISOLATED_ENV = (home) => ({
  PATH: process.env.PATH,
  HOME: home,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: ISOLATED_ENV(dir), timeout: GIT_TIMEOUT_MS }).trim();
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

function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-prmarker-'));
  git(dir, '-c', 'init.defaultBranch=main', 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, 'code.txt', 'v0\n');
  write(dir, '.planning/STATE.md', 's0\n');
  commitAll(dir, 'chore: base');
  git(dir, 'checkout', '-q', '-b', 'feature');
  return dir;
}

// One code+planning commit and one planning-only commit, both tagged rN.
function commitRound(dir, n) {
  write(dir, 'code.txt', `v${n}\n`);
  write(dir, `.planning/phases/r${n}.md`, `plan ${n}\n`);
  commitAll(dir, `feat: r${n}`);
  write(dir, '.planning/STATE.md', `s${n}\n`);
  commitAll(dir, `docs: r${n}`);
}

// Runs the shipped blocks in workflow order under pr_strict.
function publish(dir, target = 'main') {
  const text = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  const b = (marker) => extractBashBlockContaining(text, marker);
  const script = [
    'CURRENT_BRANCH=feature',
    `TARGET=${target}`,
    'PR_STRICT=true',
    b('PR_BRANCH="${CURRENT_BRANCH}-pr"'),
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

// Script goes through a temp file, not `sh -c` argv (Windows MSYS2 mis-parses long quote-heavy argv).
function runSh(script, cwd) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-prmarker-script-'));
  try {
    const file = path.join(tmp, 'recipe.sh');
    fs.writeFileSync(file, script);
    const r = spawnSync('sh', [file], { cwd, encoding: 'utf8', env: ISOLATED_ENV(cwd), timeout: GIT_TIMEOUT_MS });
    return runResult(r);
  } finally { cleanup(tmp); }
}

function runResult(r) {
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Fast-forward the bare target to the published -pr branch (a merged PR).
function mergePr(dir, target = 'main') {
  git(dir, 'merge-base', '--is-ancestor', target, 'feature-pr');
  git(dir, 'update-ref', `refs/heads/${target}`, 'refs/heads/feature-pr');
}

const refOf = (dir, ref) => {
  try { return git(dir, 'rev-parse', '-q', '--verify', ref); } catch { return ''; }
};
const markerOf = (dir) => refOf(dir, MARKER);
const pendingOf = (dir) => refOf(dir, PENDING);
const builtOf = (dir) => refOf(dir, BUILT);
const loggedOf = (r) => r.stdout.split('\n').filter((l) => /\b(feat|docs): r\d/.test(l));

describe('#5469 pr-branch published marker (real git)', () => {
  const dirs = [];
  const repo = () => { const d = buildRepo(); dirs.push(d); return d; };
  const teardown = () => { while (dirs.length) cleanup(dirs.pop()); };

  test('round 3 replays only the round-3 commits; marker follows the tip; merged leftover -pr is replaced', () => {
    const dir = repo();
    let prevTip = '';
    try {
      for (const n of [1, 2, 3]) {
        commitRound(dir, n);
        const tip = git(dir, 'rev-parse', 'feature');
        const r = publish(dir);
        assert.equal(r.status, 0, `round ${n} failed: ${r.stderr}`);
        const logged = loggedOf(r);
        assert.equal(logged.length, 2, `round ${n} must list only its own 2 commits:\n${r.stdout}`);
        assert.ok(logged.every((l) => l.includes(`r${n}`)), `round ${n} log replays older rounds:\n${r.stdout}`);
        assert.equal(git(dir, 'rev-list', '--count', 'main..feature-pr'), '1');
        assert.equal(pendingOf(dir), tip, 'build records the TIP captured at start as pending');
        assert.equal(builtOf(dir), git(dir, 'rev-parse', 'feature-pr'), 'build records the -pr tip beside pending');
        assert.equal(markerOf(dir), n === 1 ? '' : prevTip, 'marker is promoted only after the PR branch is merged');
        mergePr(dir);
        prevTip = tip;
      }
    } finally { teardown(); }
  });

  test('leftover UNmerged -pr is refused with a message naming it, and left intact', () => {
    const dir = repo();
    try {
      commitRound(dir, 1);
      assert.equal(publish(dir).status, 0);
      const prTip = git(dir, 'rev-parse', 'feature-pr');
      commitRound(dir, 2);
      const r = publish(dir);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /feature-pr/);
      assert.match(r.stderr, /unpublished|unmerged/);
      assert.match(r.stderr, /git branch -D feature-pr/);
      assert.match(r.stderr, /git update-ref refs\/gsd\/pr-published\/main\/feature \$\(git rev-parse refs\/gsd\/pr-built\/main\/feature\)/);
      assert.equal(git(dir, 'rev-parse', 'feature-pr'), prTip);
      assert.equal(git(dir, 'branch', '--show-current'), 'feature');
    } finally { teardown(); }
  });

  test('rebased working branch (marker not an ancestor) falls back to TARGET with a warning', () => {
    const dir = repo();
    try {
      commitRound(dir, 1);
      assert.equal(publish(dir).status, 0);
      mergePr(dir);
      // Rewrite history: reword the tip so the marker is no longer an ancestor.
      git(dir, 'commit', '-q', '--amend', '-m', 'docs: r1 reworded');
      commitRound(dir, 2);
      const r = publish(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /refs\/gsd\/pr-published\/main\/feature is not an ancestor/);
      assert.match(r.stderr, /git update-ref refs\/gsd\/pr-published\/main\/feature <rebased commit/);
      assert.equal(git(dir, 'show', 'feature-pr:code.txt'), 'v2');
      assert.equal(pendingOf(dir), git(dir, 'rev-parse', 'feature'));
    } finally { teardown(); }
  });

  test('marker does not advance when a conflict halts the run', () => {
    const dir = repo();
    try {
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
    } finally { teardown(); }
  });

  test('discarded -pr branch: unpublished commits are replayed, pending is dropped', () => {
    const dir = repo();
    try {
      commitRound(dir, 1);
      assert.equal(publish(dir).status, 0);
      git(dir, 'branch', '-D', 'feature-pr');
      commitRound(dir, 2);
      const r = publish(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(loggedOf(r).length, 4, `discarded round 1 must be replayed:\n${r.stdout}`);
      assert.equal(markerOf(dir), '', 'nothing was published');
      assert.equal(pendingOf(dir), git(dir, 'rev-parse', 'feature'));
    } finally { teardown(); }
  });

  test('merged then locally deleted -pr: pending is promoted, nothing replayed', () => {
    const dir = repo();
    try {
      commitRound(dir, 1);
      assert.equal(publish(dir).status, 0);
      const tip1 = git(dir, 'rev-parse', 'feature');
      mergePr(dir);
      git(dir, 'branch', '-D', 'feature-pr');
      commitRound(dir, 2);
      const r = publish(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(markerOf(dir), tip1, 'merged build is promoted despite the deleted -pr branch');
      assert.equal(loggedOf(r).length, 2, `only round 2 may be replayed:\n${r.stdout}`);
      assert.ok(loggedOf(r).every((l) => l.includes('r2')));
    } finally { teardown(); }
  });

  test('refusal without a pending ref prints only the discard command', () => {
    const dir = repo();
    try {
      git(dir, 'checkout', '-q', '-b', 'feature-pr', 'main');
      write(dir, 'other.txt', 'x\n');
      commitAll(dir, 'chore: stray');
      git(dir, 'checkout', '-q', 'feature');
      commitRound(dir, 1);
      const r = publish(dir);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /git branch -D feature-pr/);
      assert.doesNotMatch(r.stderr, /update-ref/);
    } finally { teardown(); }
  });

  test('squash-merged -pr: documented manual commands re-anchor the next run', () => {
    const dir = repo();
    try {
      commitRound(dir, 1);
      assert.equal(publish(dir).status, 0);
      git(dir, 'checkout', '-q', 'main');
      git(dir, 'checkout', 'feature-pr', '--', 'code.txt');
      commitAll(dir, 'feat: squashed r1');
      git(dir, 'checkout', '-q', 'feature');
      commitRound(dir, 2);
      const refused = publish(dir);
      assert.notEqual(refused.status, 0);
      const cmd = refused.stderr.match(/git update-ref \S+ \$\(git rev-parse \S+\) && git branch -D \S+/);
      assert.ok(cmd, `refusal must print the squash/rebase command:\n${refused.stderr}`);
      const recovered = runSh(cmd[0], dir);
      assert.equal(recovered.status, 0, `recovery command failed: ${recovered.stderr}`);
      const r = publish(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(loggedOf(r).length, 2, `only round 2 may be replayed:\n${r.stdout}`);
      assert.ok(loggedOf(r).every((l) => l.includes('r2')));
    } finally { teardown(); }
  });

  test('markers are keyed by target: a release run does not anchor a main run', () => {
    const dir = repo();
    try {
      git(dir, 'branch', 'release', 'main');
      commitRound(dir, 1);
      assert.equal(publish(dir, 'release').status, 0);
      mergePr(dir, 'release');
      commitRound(dir, 2);
      assert.equal(publish(dir, 'release').status, 0);
      const releaseMarker = refOf(dir, 'refs/gsd/pr-published/release/feature');
      assert.ok(releaseMarker, 'release marker promoted');
      git(dir, 'branch', '-D', 'feature-pr');
      const r = publish(dir, 'main');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(loggedOf(r).length, 4, `main must replay from main, not from the release marker:\n${r.stdout}`);
      assert.equal(markerOf(dir), '');
      assert.equal(refOf(dir, 'refs/gsd/pr-published/release/feature'), releaseMarker);
    } finally { teardown(); }
  });

  test('target merged into the feature branch after a publish: teammate commits are not picked', () => {
    const dir = repo();
    try {
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
      assert.equal(loggedOf(r).length, 2, `only round 2 may be listed:\n${r.stdout}`);
      assert.doesNotMatch(r.stdout, /teammate/);
      assert.equal(git(dir, 'show', 'feature-pr:code.txt'), 'v2');
    } finally { teardown(); }
  });

  test('-pr rebased before merge: merged branch tip still promotes the marker', () => {
    const dir = repo();
    try {
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
      assert.equal(loggedOf(r).length, 2, `only round 2 may be replayed:\n${r.stdout}`);
      assert.ok(loggedOf(r).every((l) => l.includes('r2')));
      assert.equal(markerOf(dir), tip1);
    } finally { teardown(); }
  });
});
