'use strict';

/**
 * Regression tests for gsd:pr-branch silently ignoring sub_repos (#666).
 *
 * Root causes:
 * 1. Workflow called `config-get sub_repos` (top-level key — not found);
 *    `|| echo ""` swallowed the non-zero exit → step always skipped.
 * 2. No .cjs seam existed; git work was inline bash with `git add -A`
 *    (forbidden by universal-anti-patterns.md:44).
 *
 * Fixes:
 * - `cmdPrSubrepo` in commands.cjs: branch + explicit file staging (no add -A)
 *   + commit + push --set-upstream; returns structured JSON.
 * - Workflow uses `planning.sub_repos` (canonical key per bug #2638) and
 *   delegates git work to `gsd_run query pr-subrepo`.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(dir, obj) {
  const planningDir = path.join(dir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify(obj, null, 2));
}

function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  // Pre-commit fixture files so tests can modify tracked files (porcelain " M", not "??")
  // cmdPrSubrepo filters out untracked ?? lines — tests must use tracked modifications.
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  fs.writeFileSync(path.join(dir, 'feature.js'), '// initial\n');
  fs.writeFileSync(path.join(dir, 'a.js'), '// initial\n');
  fs.writeFileSync(path.join(dir, 'b.js'), '// initial\n');
  execFileSync('git', ['add', '.gitkeep', 'feature.js', 'a.js', 'b.js'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'chore: initial commit'], { cwd: dir, stdio: 'pipe' });
}

function wireRemote(repoDir, bareDir) {
  fs.mkdirSync(bareDir, { recursive: true });
  execFileSync('git', ['init', '--bare'], { cwd: bareDir, stdio: 'pipe' });
  execFileSync('git', ['remote', 'add', 'origin', bareDir], { cwd: repoDir, stdio: 'pipe' });
  const branch = execFileSync('git', ['branch', '--show-current'], {
    cwd: repoDir, encoding: 'utf8',
  }).trim();
  execFileSync('git', ['push', 'origin', branch], { cwd: repoDir, stdio: 'pipe' });
}

// ---------------------------------------------------------------------------
// Behavioral tests — exercise the pr-subrepo seam via runGsdTools
// ---------------------------------------------------------------------------

describe('bug #666 — cmdPrSubrepo seam (behavioral)', () => {
  let rootDir;
  let subDir;
  let bareDir;

  beforeEach(() => {
    rootDir = createTempDir('gsd-666-root-');
    subDir  = path.join(rootDir, 'backend');
    bareDir = path.join(rootDir, '_bare-backend.git');
    writeConfig(rootDir, { planning: { sub_repos: ['backend'] } });
    gitInit(subDir);
    wireRemote(subDir, bareDir);
  });

  afterEach(() => {
    cleanup(rootDir);
  });

  test('config-get planning.sub_repos resolves canonical config location', () => {
    const res = runGsdTools(['query', 'config-get', 'planning.sub_repos'], rootDir);
    assert.ok(res.success, `config-get planning.sub_repos failed: ${res.error}`);
    assert.deepStrictEqual(JSON.parse(res.output), ['backend']);
  });

  test('config-get sub_repos (top-level) fails — confirming Blocker 1 is gone', () => {
    const res = runGsdTools(['query', 'config-get', 'sub_repos'], rootDir);
    assert.ok(!res.success, 'top-level sub_repos key must not resolve — Blocker 1 fix requires planning.sub_repos');
  });

  test('pr-subrepo happy path: branch created, files staged explicitly, commit pushed', () => {
    // Overwrite tracked file (porcelain " M") — untracked ?? lines are filtered by design
    fs.writeFileSync(path.join(subDir, 'feature.js'), 'module.exports = 42;\n');

    const res = runGsdTools(
      ['query', 'pr-subrepo', 'fix(backend): add feature',
       '--repo', 'backend', '--branch', 'fix-666-backend-pr'],
      rootDir
    );
    assert.ok(res.success, `pr-subrepo failed: ${res.error}`);

    const result = JSON.parse(res.output);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.repo, 'backend');
    assert.strictEqual(result.branch, 'fix-666-backend-pr');
    assert.strictEqual(result.committed, true);
    assert.ok(Array.isArray(result.files) && result.files.length > 0);
    assert.ok(result.files.includes('feature.js'), `feature.js missing from files: ${JSON.stringify(result.files)}`);
    assert.ok(typeof result.commit_hash === 'string' && result.commit_hash.length > 0);
  });

  test('pr-subrepo stages files explicitly — result.files lists every changed file', () => {
    // Overwrite tracked files (porcelain " M") — untracked ?? lines are filtered by design
    fs.writeFileSync(path.join(subDir, 'a.js'), '1\n');
    fs.writeFileSync(path.join(subDir, 'b.js'), '2\n');

    const res = runGsdTools(
      ['query', 'pr-subrepo', 'fix(backend): two files',
       '--repo', 'backend', '--branch', 'fix-666-explicit-pr'],
      rootDir
    );
    assert.ok(res.success, `pr-subrepo failed: ${res.error}`);

    const result = JSON.parse(res.output);
    assert.ok(result.files.includes('a.js'), 'a.js must be staged');
    assert.ok(result.files.includes('b.js'), 'b.js must be staged');
  });

  test('pr-subrepo: nothing_to_commit when sub-repo is clean', () => {
    const res = runGsdTools(
      ['query', 'pr-subrepo', 'fix(backend): nothing',
       '--repo', 'backend', '--branch', 'fix-666-clean-pr'],
      rootDir
    );
    assert.ok(res.success, `pr-subrepo should succeed on clean repo: ${res.error}`);
    const result = JSON.parse(res.output);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.committed, false);
    assert.strictEqual(result.reason, 'nothing_to_commit');
  });

  test('pr-subrepo: duplicate branch guard — errors when branch already exists', () => {
    fs.writeFileSync(path.join(subDir, 'a.js'), '1\n');
    const first = runGsdTools(
      ['query', 'pr-subrepo', 'fix(backend): first',
       '--repo', 'backend', '--branch', 'fix-666-dup-pr'],
      rootDir
    );
    assert.ok(first.success, `first call failed: ${first.error}`);

    fs.writeFileSync(path.join(subDir, 'b.js'), '2\n');
    const second = runGsdTools(
      ['query', 'pr-subrepo', 'fix(backend): second',
       '--repo', 'backend', '--branch', 'fix-666-dup-pr'],
      rootDir
    );
    assert.ok(!second.success, 'Expected failure on duplicate branch name');
    assert.ok(second.error.includes('already exists'), `Got: ${second.error}`);
  });

  test('pr-subrepo: missing --repo returns descriptive error', () => {
    const res = runGsdTools(
      ['query', 'pr-subrepo', 'fix: msg', '--branch', 'some-branch'],
      rootDir
    );
    assert.ok(!res.success);
    assert.ok(res.error.includes('--repo required'), `Got: ${res.error}`);
  });

  test('pr-subrepo: missing --branch returns descriptive error', () => {
    const res = runGsdTools(
      ['query', 'pr-subrepo', 'fix: msg', '--repo', 'backend'],
      rootDir
    );
    assert.ok(!res.success);
    assert.ok(res.error.includes('--branch required'), `Got: ${res.error}`);
  });

  test('pr-subrepo: missing commit message returns descriptive error', () => {
    const res = runGsdTools(
      ['query', 'pr-subrepo', '--repo', 'backend', '--branch', 'some-branch'],
      rootDir
    );
    assert.ok(!res.success);
    assert.ok(res.error.includes('commit message required'), `Got: ${res.error}`);
  });

  test('pr-subrepo: non-existent repo path returns descriptive error', () => {
    const res = runGsdTools(
      ['query', 'pr-subrepo', 'fix: msg', '--repo', 'nonexistent', '--branch', 'some-branch'],
      rootDir
    );
    assert.ok(!res.success);
    assert.ok(
      res.error.includes('not found') || res.error.includes('nonexistent'),
      `Got: ${res.error}`
    );
  });

  test('pr-subrepo: path traversal (../escape) is rejected', () => {
    const res = runGsdTools(
      ['query', 'pr-subrepo', 'fix: msg', '--repo', '../escape', '--branch', 'some-branch'],
      rootDir
    );
    assert.ok(!res.success, 'Expected failure on path traversal attempt');
    assert.ok(
      res.error.includes('unsafe') || res.error.includes('escape'),
      `Got: ${res.error}`
    );
  });
});

// ---------------------------------------------------------------------------
// Source-text assertions — workflow file is the deployed contract
// ---------------------------------------------------------------------------

// allow-test-rule: source-text-is-the-product
// pr-branch.md is a workflow file whose deployed text IS the runtime contract.

describe('bug #666 — pr-branch.md workflow source invariants', () => {
  const workflowPath = path.resolve(__dirname, '..', 'gsd-core', 'workflows', 'pr-branch.md');
  let content;

  test('setup', () => {
    content = fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.length > 0);
  });

  test('uses planning.sub_repos (canonical key) — not legacy top-level sub_repos', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(
      content.includes('planning.sub_repos'),
      'must call config-get planning.sub_repos'
    );
    assert.ok(
      !/config-get sub_repos(?!\.)/.test(content),
      'must not call config-get sub_repos without the planning. prefix'
    );
  });

  test('delegates git work to gsd_run query pr-subrepo — no inline git add -A in code', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(content.includes('pr-subrepo'), 'must invoke the pr-subrepo seam');
    // Match `git add -A` or `git add .` only as a shell command (at line start, optionally
    // prefixed with git -C ...) — excludes prose notes like "never use git add -A".
    const hasForbiddenGitAdd = /^\s*git(?:\s+-C\s+\S+)?\s+add\s+(?:-A|\.)\b/m.test(content);
    assert.ok(!hasForbiddenGitAdd, 'must not use git add -A or git add . as a shell command');
  });

  test('persists dirty-repo list without bash arrays (temp file or inline string)', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(
      !content.includes('DIRTY_REPOS=()') && !content.includes('DIRTY_REPOS+='),
      'bash arrays must not be used — they do not survive across command blocks'
    );
  });

  test('branch name includes repo-specific slug to avoid root PR_BRANCH collision', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    assert.ok(
      /REPO_SAFE|SUB_BRANCH.*REPO/.test(content),
      'sub-repo branch name must embed a repo-specific component'
    );
  });

  test('handle_sub_repos positioned before analyze_commits', () => {
    content = content || fs.readFileSync(workflowPath, 'utf-8');
    const a = content.indexOf('handle_sub_repos');
    const b = content.indexOf('analyze_commits');
    assert.ok(a !== -1 && b !== -1 && a < b);
  });
});
