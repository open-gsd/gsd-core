'use strict';
/**
 * #1146: git.base-branch resolver — single source of truth for default-branch detection.
 *
 * Tests:
 *   A. Config override wins (git.base_branch set → returned as-is, no git calls needed)
 *   B. origin/HEAD symref resolves → used
 *   C. origin/HEAD unset but git remote show origin knows HEAD → AUTHORITATIVE fallback
 *      (key regression: master repo with no origin/HEAD → must return "master", NOT "main")
 *   D. No origin/HEAD, no remote show, local branch "master" present → returns "master"
 *   E. No origin/HEAD, no remote show, local branch "main" present → returns "main"
 *   F. No origin/HEAD, no remote show, no local branches → returns "main" (last resort)
 *   G. Anti-regression guard: five affected workflows must NOT contain the
 *      duplicated bare `:-main` / `:-master` fallback pattern that was the root cause.
 *      They must call `gsd_run query git.base-branch` instead.
 *      (allow-test-rule: runtime-contract-is-the-product — the workflow .md content IS
 *       the runtime surface; the absence of the bad pattern is what ships to agents.)
 */

// allow-test-rule: runtime-contract-is-the-product
// Justification: the workflow .md files ARE the product surface — agents read and
// execute them directly. Guard G asserts that the resolved command appears in all five
// workflows, which requires reading those workflow files. Per TESTING-STANDARDS.md §6.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { runGsdTools, cleanup } = require('./helpers.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a minimal git repo in a temp dir, optionally setting up a remote
 * and local branches.
 */
function createGitRepo(opts = {}) {
  const { prefix = 'gsd-1146-', defaultBranch = 'master' } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync(`git init -b ${defaultBranch}`, { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'pipe' });
  // Need at least one commit so branches exist
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

/**
 * Create a .planning dir so gsd-tools resolveProjectRoot doesn't bail.
 */
function addPlanning(dir) {
  fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
}

/**
 * Write a gsd config.json with git.base_branch set.
 */
function setGsdConfig(dir, key, value) {
  const cfgDir = path.join(dir, '.planning');
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) { /* new file */ }
  // Set nested key (dot notation). Guard every segment against prototype
  // pollution with inline literal checks at each write site — mirrors the
  // production guard in src/config.cts. A Set/pre-loop guard is NOT recognised
  // by CodeQL's js/prototype-pollution-utility query (see PR #752 / alert #40).
  const parts = key.split('.');
  let obj = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') {
      throw new Error(`setGsdConfig: unsafe config key segment '${k}'`);
    }
    if (typeof obj[k] !== 'object' || obj[k] === null) obj[k] = {};
    obj = obj[k];
  }
  const lastKey = parts[parts.length - 1];
  if (lastKey === '__proto__' || lastKey === 'prototype' || lastKey === 'constructor') {
    throw new Error(`setGsdConfig: unsafe config key segment '${lastKey}'`);
  }
  obj[lastKey] = value;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
}

// Paths to the five affected workflow files
const WORKFLOW_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const AFFECTED_WORKFLOWS = [
  path.join(WORKFLOW_DIR, 'execute-phase.md'),
  path.join(WORKFLOW_DIR, 'quick.md'),
  path.join(WORKFLOW_DIR, 'ship.md'),
  path.join(WORKFLOW_DIR, 'complete-milestone.md'),
  path.join(WORKFLOW_DIR, 'pr-branch.md'),
];

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('#1146: git.base-branch resolver', () => {

  test('A. config override git.base_branch → returned immediately', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-1146-a-', defaultBranch: 'master' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    setGsdConfig(dir, 'git.base_branch', 'develop');

    const result = runGsdTools(['query', 'git.base-branch'], dir);
    assert.ok(result.success, `git.base-branch with config override failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'develop',
      `Expected config override 'develop', got: '${branch}'`);
  });

  test('B. origin/HEAD symref resolves → returned', (t) => {
    // Create an "origin" bare repo with main branch
    const originDir = createGitRepo({ prefix: 'gsd-1146-b-origin-', defaultBranch: 'main' });
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1146-b-wt-'));
    t.after(() => { cleanup(originDir); cleanup(worktreeDir); });

    // Clone from origin — this sets origin/HEAD
    execSync(`git clone "${originDir}" "${worktreeDir}"`, { stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: worktreeDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: worktreeDir, stdio: 'pipe' });
    addPlanning(worktreeDir);

    // Verify origin/HEAD is set (it should be after clone)
    const symref = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd: worktreeDir, encoding: 'utf8' }).trim();
    assert.ok(symref.includes('origin/main'), `Expected origin/HEAD→origin/main, got: ${symref}`);

    const result = runGsdTools(['query', 'git.base-branch'], worktreeDir);
    assert.ok(result.success, `git.base-branch symref test failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'main',
      `Expected 'main' from origin/HEAD, got: '${branch}'`);
  });

  test('C. KEY REGRESSION — master repo, origin/HEAD unset → returns "master" not "main"', (t) => {
    // This is the bug: git init + remote add without git remote set-head → no origin/HEAD
    // Current code falls back to :-main → wrong. Fixed code uses `git remote show origin`.
    const originDir = createGitRepo({ prefix: 'gsd-1146-c-origin-', defaultBranch: 'master' });
    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1146-c-clone-'));
    t.after(() => { cleanup(originDir); cleanup(cloneDir); });

    // Manually add remote WITHOUT cloning (so origin/HEAD is never set)
    execSync('git init', { cwd: cloneDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: cloneDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: cloneDir, stdio: 'pipe' });
    execSync('git config commit.gpgsign false', { cwd: cloneDir, stdio: 'pipe' });
    execSync(`git remote add origin "${originDir}"`, { cwd: cloneDir, stdio: 'pipe' });
    execSync('git fetch origin', { cwd: cloneDir, stdio: 'pipe' });
    // Explicitly delete origin/HEAD in case git fetch auto-set it (newer git versions may do this)
    try {
      execSync('git remote set-head origin --delete', { cwd: cloneDir, stdio: 'pipe' });
    } catch (_) { /* ignore — may not exist */ }
    addPlanning(cloneDir);

    // Confirm origin/HEAD is unset
    let hasSymref = true;
    try {
      execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd: cloneDir, stdio: 'pipe' });
    } catch (_) {
      hasSymref = false;
    }
    assert.strictEqual(hasSymref, false, 'Test setup: origin/HEAD must be unset for this test case');

    const result = runGsdTools(['query', 'git.base-branch'], cloneDir);
    assert.ok(result.success, `git.base-branch regression test failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'master',
      `BUG REGRESSION: master repo with origin/HEAD unset must return 'master', got: '${branch}'`);
  });

  test('D. No remote, local branch "master" present, "main" absent → returns "master"', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-1146-d-', defaultBranch: 'master' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    // No remote configured — falls through to local branch detection

    const result = runGsdTools(['query', 'git.base-branch'], dir);
    assert.ok(result.success, `git.base-branch local branch test failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'master',
      `Expected 'master' from local branch detection, got: '${branch}'`);
  });

  test('E. No remote, local branch "main" present → returns "main"', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-1146-e-', defaultBranch: 'main' });
    t.after(() => cleanup(dir));
    addPlanning(dir);

    const result = runGsdTools(['query', 'git.base-branch'], dir);
    assert.ok(result.success, `git.base-branch main branch test failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'main',
      `Expected 'main' from local branch detection, got: '${branch}'`);
  });

  test('F. No remote, no main/master local branch → returns "main" (last resort default)', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-1146-f-', defaultBranch: 'develop' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    // Branch named "develop" — neither main nor master

    const result = runGsdTools(['query', 'git.base-branch'], dir);
    assert.ok(result.success, `git.base-branch default fallback test failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'main',
      `Expected 'main' as last resort default, got: '${branch}'`);
  });

  test('A2. config override with flat base_branch key (legacy form) → returned immediately', (t) => {
    const dir = createGitRepo({ prefix: 'gsd-1146-a2-', defaultBranch: 'master' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    // Write flat base_branch directly to config root (legacy form, not nested under "git")
    const cfgPath = require('node:path').join(dir, '.planning', 'config.json');
    require('node:fs').writeFileSync(cfgPath, JSON.stringify({ base_branch: 'release' }, null, 2) + '\n');

    const result = runGsdTools(['query', 'git.base-branch'], dir);
    assert.ok(result.success, `git.base-branch with flat config key failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'release',
      `Expected flat config override 'release', got: '${branch}'`);
  });

  test('H. No remote, both "main" and "master" local branches exist → returns "main" (main wins tie-break)', (t) => {
    // Tier-4 tie-break: when both main and master exist locally and no remote info is available,
    // "main" wins (documented in tryLocalBranch JSDoc — modern default).
    const dir = createGitRepo({ prefix: 'gsd-1146-h-', defaultBranch: 'master' });
    t.after(() => cleanup(dir));
    addPlanning(dir);
    // Create a "main" branch alongside the existing "master"
    const { execSync: exec } = require('node:child_process');
    exec('git branch main', { cwd: dir, stdio: 'pipe' });
    // No remote configured — falls to tier-4 (local branch existence)

    const result = runGsdTools(['query', 'git.base-branch'], dir);
    assert.ok(result.success, `git.base-branch both-branches test failed:\n${result.error}`);
    const branch = result.output.trim();
    assert.strictEqual(branch, 'main',
      `Expected 'main' to win when both main and master exist locally, got: '${branch}'`);
  });

  test('G. Anti-regression: all five affected workflows use gsd_run query git.base-branch, not bare :-main / :-master', () => {
    // The root-cause pattern: DEFAULT_BRANCH=${DEFAULT_BRANCH:-main} or BASE_BRANCH="${BASE_BRANCH:-main}"
    // After fix: workflows call gsd_run query git.base-branch and remove the bare fallback.
    const BAD_PATTERN = /\$\{(?:DEFAULT_BRANCH|BASE_BRANCH):-(?:main|master)\}/;
    const RESOLVER_CALL = /gsd_run query git\.base-branch/;

    for (const wfPath of AFFECTED_WORKFLOWS) {
      const name = path.basename(wfPath);
      const content = fs.readFileSync(wfPath, 'utf8');

      assert.ok(
        !BAD_PATTERN.test(content),
        `${name} still contains the bare :-main/:-master fallback pattern. ` +
        'Must be replaced with gsd_run query git.base-branch (Issue #1146).',
      );

      assert.ok(
        RESOLVER_CALL.test(content),
        `${name} does not call \`gsd_run query git.base-branch\`. ` +
        'All five affected workflows must delegate to the single resolver (Issue #1146).',
      );
    }
  });
});

// ─── gitWorktreeInfoInternal: behaviour (#1268 T0, T1 #1277) ─────────────────

const gitBaseBranch = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'git-base-branch.cjs'));
const { createTempGitProject, createTempDir } = require('./helpers.cjs');

describe('#1268 gitWorktreeInfoInternal: relocation to git-base-branch', () => {
  test('gitWorktreeInfoInternal(createTempGitProject()) returns {inside:true, worktreeRoot:<non-empty string>}', (t) => {
    const dir = createTempGitProject('gsd-wt-info-');
    t.after(() => cleanup(dir));
    const result = gitBaseBranch.gitWorktreeInfoInternal(dir);
    assert.strictEqual(result.inside, true, 'inside must be true for a git project dir');
    assert.ok(typeof result.worktreeRoot === 'string' && result.worktreeRoot.length > 0,
      `worktreeRoot must be a non-empty string, got: ${JSON.stringify(result.worktreeRoot)}`);
  });

  test('gitWorktreeInfoInternal(createTempDir()) returns {inside:false, worktreeRoot:null} for a non-git dir', (t) => {
    const dir = createTempDir('gsd-wt-info-nongit-');
    t.after(() => cleanup(dir));
    const result = gitBaseBranch.gitWorktreeInfoInternal(dir);
    assert.strictEqual(result.inside, false, 'inside must be false for a non-git dir');
    assert.strictEqual(result.worktreeRoot, null, 'worktreeRoot must be null for a non-git dir');
  });

  test('gitWorktreeInfoInternal never throws (non-git dir)', (t) => {
    const dir = createTempDir('gsd-wt-info-nothrow-');
    t.after(() => cleanup(dir));
    assert.doesNotThrow(() => gitBaseBranch.gitWorktreeInfoInternal(dir));
  });
});

// ─── setGsdConfig prototype-pollution guard (#1406) ───────────────────────────

describe('#1406: setGsdConfig prototype-pollution guard', () => {
  test('rejects __proto__ as a key segment', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1406-'));
    t.after(() => cleanup(dir));
    assert.throws(() => setGsdConfig(dir, '__proto__', 'x'), /unsafe config key segment/);
    assert.throws(() => setGsdConfig(dir, '__proto__.polluted', true), /unsafe config key segment/);
  });

  test('rejects constructor / prototype chain segments', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1406-'));
    t.after(() => cleanup(dir));
    assert.throws(() => setGsdConfig(dir, 'constructor.prototype.polluted', true), /unsafe config key segment/);
    assert.throws(() => setGsdConfig(dir, 'safe.__proto__', true), /unsafe config key segment/);
    assert.throws(() => setGsdConfig(dir, 'a.prototype.b', true), /unsafe config key segment/);
  });

  test('does not pollute Object.prototype after rejected attempts', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1406-'));
    t.after(() => cleanup(dir));
    try { setGsdConfig(dir, '__proto__.polluted', true); } catch (_) { /* expected */ }
    try { setGsdConfig(dir, 'constructor.prototype.polluted', true); } catch (_) { /* expected */ }
    try { setGsdConfig(dir, 'a.__proto__.polluted', true); } catch (_) { /* expected */ }
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(Object.prototype.polluted, undefined);
  });

  test('still writes a normal nested key', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1406-'));
    t.after(() => cleanup(dir));
    setGsdConfig(dir, 'git.base_branch', 'develop');
    const cfgPath = path.join(dir, '.planning', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.strictEqual(cfg.git.base_branch, 'develop');
  });
});
