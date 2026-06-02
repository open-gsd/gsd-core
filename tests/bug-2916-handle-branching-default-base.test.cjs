/**
 * Regression test for #2916: execute-phase `handle_branching` step creates the
 * per-phase branch off whatever HEAD is currently checked out (typically the
 * previous phase's unmerged branch) instead of off `origin/HEAD`.
 *
 * The bug compounded phases on top of each other and stranded them unpushed
 * for weeks. The fix:
 *   1. Detect the default branch via `git symbolic-ref refs/remotes/origin/HEAD`.
 *   2. If $BRANCH_NAME exists, switch to it (preserve existing behavior).
 *   3. Otherwise, ff-update the default branch from origin and create the new
 *      phase branch off the default-branch tip.
 *   4. Refuse-or-warn on dirty working tree.
 *   5. Post-creation, assert `git rev-list --count $DEFAULT_BRANCH..HEAD == 0`.
 *
 * This test extracts the bash payload from the <step name="handle_branching">
 * block in execute-phase.md (parsed structurally — no regex on prose), executes
 * it inside a fixture git repo where HEAD sits on a previous-phase branch with
 * extra commits, and asserts that the new phase branch's tip equals
 * `origin/main` (no commits inherited from the previous phase).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

const EXECUTE_PHASE_PATH = path.join(
  __dirname,
  '..',
  'get-shit-done',
  'workflows',
  'execute-phase.md'
);

const GIT_ENV = Object.freeze({
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com',
});

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: GIT_ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

/**
 * Structurally extract the bash code that the handle_branching step instructs
 * the agent to run. We:
 *   1. Locate the <step name="handle_branching"> ... </step> block.
 *   2. Walk its body looking for fenced ```bash blocks.
 *   3. Concatenate every bash block in the step (the fix may use more than one).
 *
 * No `.includes()` content checks — we parse fence-delimited code blocks the
 * same way a markdown parser would.
 */
function extractHandleBranchingBash() {
  const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');
  const lines = content.split(/\r?\n/);

  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (start === -1 && /^<step\s+name="handle_branching">\s*$/.test(lines[i])) {
      start = i + 1;
    } else if (start !== -1 && /^<\/step>\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1 || end === -1) {
    throw new Error(
      'execute-phase.md does not contain a <step name="handle_branching"> ... </step> block'
    );
  }

  const bashBlocks = [];
  let inBash = false;
  let buffer = [];
  for (let i = start; i < end; i += 1) {
    const line = lines[i];
    if (!inBash && /^```bash\s*$/.test(line)) {
      inBash = true;
      buffer = [];
      continue;
    }
    if (inBash && /^```\s*$/.test(line)) {
      bashBlocks.push(buffer.join('\n'));
      inBash = false;
      continue;
    }
    if (inBash) buffer.push(line);
  }
  if (bashBlocks.length === 0) {
    throw new Error(
      'handle_branching step contains no ```bash code blocks to execute'
    );
  }
  return bashBlocks.join('\n');
}

/**
 * Build a fixture: a bare "origin" repo with the named default branch (one
 * commit), a clone with `origin/HEAD` pointed at it, and a checked-out
 * previous-phase branch carrying its own unmerged commit.
 *
 * `defaultBranch` is parameterized so callers can lock in that the workflow
 * honors `git symbolic-ref refs/remotes/origin/HEAD` rather than silently
 * defaulting to `main` (#2921 CR feedback — quick-branching.test.cjs got the
 * same treatment in 80f14cac; this test deserves the same coverage).
 */
function setupFixture(defaultBranch = 'main') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2916-'));
  const seedPath = path.join(root, 'seed');
  const originPath = path.join(root, 'origin.git');
  const clonePath = path.join(root, 'clone');

  fs.mkdirSync(seedPath);
  git(seedPath, 'init', '-b', defaultBranch);
  git(seedPath, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(seedPath, 'README.md'), '# seed\n');
  git(seedPath, 'add', 'README.md');
  git(seedPath, 'commit', '-m', 'initial');

  git(root, 'clone', '--bare', seedPath, originPath);
  git(originPath, 'symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`);

  git(root, 'clone', originPath, clonePath);
  git(clonePath, 'config', 'commit.gpgsign', 'false');
  git(clonePath, 'config', 'user.email', 'test@test.com');
  git(clonePath, 'config', 'user.name', 'Test');

  // Simulate finishing a previous phase: branch off the default branch, add
  // a commit, and *stay* on it (the failure scenario described in the bug).
  git(clonePath, 'checkout', '-b', 'feature/phase-01-foundation');
  fs.writeFileSync(path.join(clonePath, 'phase01.txt'), 'phase 1 work\n');
  git(clonePath, 'add', 'phase01.txt');
  git(clonePath, 'commit', '-m', 'phase 01 work');

  return { root, clonePath, defaultBranch };
}

function runHandleBranchingStep(bash, cwd, branchName) {
  // Write the script to a sibling tempdir, not inside the repo — putting it in
  // `cwd` would create an untracked file that trips `git status --porcelain`
  // and steers the step into its dirty-tree fallback path.
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2916-step-'));
  const scriptPath = path.join(scriptDir, 'handle-branching.sh');
  const script = `#!/usr/bin/env bash\nset -uo pipefail\nBRANCH_NAME="${branchName}"\n${bash}\n`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  try {
    return execFileSync('bash', [scriptPath], {
      cwd,
      env: GIT_ENV,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
  } finally {
    cleanup(scriptDir);
  }
}

describe('handle_branching branches off origin/HEAD, not current HEAD (#2916)', () => {
  // Run against `main` (conventional default) and `trunk` (non-main default
  // exercising the symbolic-ref code path) so a regression that hard-codes
  // `main` instead of consulting origin/HEAD will fail the trunk variant.
  for (const defaultBranch of ['main', 'trunk']) {
    test(`new phase branch branches off origin/${defaultBranch} with 0 inherited commits`, () => {
      const bash = extractHandleBranchingBash();
      const { root, clonePath } = setupFixture(defaultBranch);

      try {
        const upstream = `origin/${defaultBranch}`;

        assert.equal(
          git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD'),
          'feature/phase-01-foundation'
        );
        assert.equal(
          git(clonePath, 'rev-list', '--count', `${upstream}..HEAD`),
          '1',
          `fixture should be 1 commit ahead of ${upstream}`
        );

        runHandleBranchingStep(bash, clonePath, 'feature/phase-02-content-sync');

        assert.equal(
          git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD'),
          'feature/phase-02-content-sync',
          'handle_branching should switch to the new phase branch'
        );

        const inherited = git(clonePath, 'rev-list', '--count', `${upstream}..HEAD`);
        assert.equal(
          inherited,
          '0',
          `new phase branch must branch off ${upstream}, but inherited ${inherited} commit(s) from previous-phase HEAD`
        );
        assert.equal(
          git(clonePath, 'rev-parse', 'HEAD'),
          git(clonePath, 'rev-parse', upstream),
          `new phase branch tip must equal ${upstream} tip`
        );
      } finally {
        cleanup(root);
      }
    });
  }

  test('handle_branching reuses an existing branch instead of forking again', () => {
    const bash = extractHandleBranchingBash();
    const { root, clonePath } = setupFixture();

    try {
      // Pre-create the target branch off origin/main with its own commit, then
      // walk away to a different branch — the step must switch back to it.
      git(clonePath, 'checkout', '-B', 'feature/phase-02-content-sync', 'origin/main');
      fs.writeFileSync(path.join(clonePath, 'phase02.txt'), 'phase 2 work\n');
      git(clonePath, 'add', 'phase02.txt');
      git(clonePath, 'commit', '-m', 'phase 02 wip');
      const phase02Sha = git(clonePath, 'rev-parse', 'HEAD');
      git(clonePath, 'checkout', 'feature/phase-01-foundation');

      runHandleBranchingStep(bash, clonePath, 'feature/phase-02-content-sync');

      assert.equal(
        git(clonePath, 'rev-parse', '--abbrev-ref', 'HEAD'),
        'feature/phase-02-content-sync'
      );
      assert.equal(
        git(clonePath, 'rev-parse', 'HEAD'),
        phase02Sha,
        'existing-branch tip must be preserved (no rebase/reset)'
      );
    } finally {
      cleanup(root);
    }
  });
});
