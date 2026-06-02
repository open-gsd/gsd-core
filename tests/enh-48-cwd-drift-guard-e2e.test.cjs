// allow-test-rule: integration-test-input
// Reads execute-phase.md to extract + execute the cwd-drift guard bash snippet against real git worktrees.

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const EXECUTE_PHASE_PATH = path.join(REPO_ROOT, 'get-shit-done', 'workflows', 'execute-phase.md');

// ---------------------------------------------------------------------------
// Extract the cwd-drift guard bash block from execute-phase.md
// ---------------------------------------------------------------------------

/**
 * Reads execute-phase.md and extracts the bash fenced block that implements
 * the orchestrator cwd-drift guard inside <step name="execute_waves">.
 *
 * Algorithm:
 *   1. Find <step name="execute_waves">
 *   2. After that, find the first occurrence of "cwd-drift guard"
 *   3. After that, find the first ```bash fence
 *   4. Return the body between ```bash\n and the closing ```
 *
 * Throws with a clear message if any step fails or sanity checks don't pass.
 */
function extractCwdGuardBash() {
  const content = fs.readFileSync(EXECUTE_PHASE_PATH, 'utf-8');

  const stepMarker = '<step name="execute_waves">';
  const stepIdx = content.indexOf(stepMarker);
  if (stepIdx === -1) {
    throw new Error(`extractCwdGuardBash: could not find "${stepMarker}" in ${EXECUTE_PHASE_PATH}`);
  }

  const afterStep = content.slice(stepIdx + stepMarker.length);

  const driftMarker = 'cwd-drift guard';
  const driftIdx = afterStep.indexOf(driftMarker);
  if (driftIdx === -1) {
    throw new Error(`extractCwdGuardBash: could not find "${driftMarker}" after execute_waves step in ${EXECUTE_PHASE_PATH}`);
  }

  const afterDrift = afterStep.slice(driftIdx + driftMarker.length);

  // Extract the first ```bash|sh fenced block using a CRLF-safe regex.
  // \r?\n tolerates both LF (Unix) and CRLF (Windows autocrlf=true checkouts).
  const fenceRe = /```(?:bash|sh)\r?\n([\s\S]*?)```/;
  const fenceMatch = fenceRe.exec(afterDrift);
  if (!fenceMatch) {
    throw new Error(`extractCwdGuardBash: could not find \`\`\`bash fence after cwd-drift guard heading in ${EXECUTE_PHASE_PATH}`);
  }

  const guardBash = fenceMatch[1];

  if (!guardBash.trim()) {
    throw new Error('extractCwdGuardBash: extracted bash block is empty');
  }
  if (!guardBash.includes('git rev-parse --show-toplevel')) {
    throw new Error('extractCwdGuardBash: sanity check failed — extracted block does not contain "git rev-parse --show-toplevel"');
  }
  if (!guardBash.includes('worktree-agent-')) {
    throw new Error('extractCwdGuardBash: sanity check failed — extracted block does not contain "worktree-agent-"');
  }

  return guardBash;
}

// ---------------------------------------------------------------------------
// Run guard helper
// ---------------------------------------------------------------------------

/**
 * Run the guard bash snippet in a given cwd using bash -c.
 * Returns { status, stderr }.
 */
function runGuard(guardBash, cwd) {
  const result = spawnSync('bash', ['-c', guardBash], {
    cwd,
    encoding: 'utf-8',
  });
  return { status: result.status, stderr: result.stderr || '' };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let upstreamDir;      // bare upstream git repo (the main worktree)
let featureDir;       // normal feature worktree on branch workspace/feature-x
let agentWtDir;       // agent worktree on branch worktree-agent-deadbeef
let agentSubdir;      // subdirectory inside agentWtDir
let legitUnderClaude; // non-agent worktree whose PATH is under .claude/worktrees/
const dirsToCleanup = [];

function git(cwd, args) {
  return execSync(`git ${args.map(a => `"${a}"`).join(' ')}`, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

before(() => {
  // --- upstream: the main repo with an initial commit ---
  upstreamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-48-upstream-'));
  dirsToCleanup.push(upstreamDir);

  git(upstreamDir, ['init', '-b', 'main']);
  git(upstreamDir, ['config', 'user.email', 'test@example.com']);
  git(upstreamDir, ['config', 'user.name', 'Test User']);
  git(upstreamDir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(upstreamDir, 'README.md'), '# test\n');
  git(upstreamDir, ['add', 'README.md']);
  git(upstreamDir, ['commit', '-m', 'chore: init']);

  // --- feature worktree: non-agent branch, path outside .claude/worktrees ---
  featureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-48-feature-'));
  dirsToCleanup.push(featureDir);
  // git worktree add creates the directory itself; remove so it can do so
  fs.rmdirSync(featureDir);
  git(upstreamDir, ['worktree', 'add', '-b', 'workspace/feature-x', featureDir]);

  // --- agent worktree: branch worktree-agent-deadbeef ---
  // Sits under featureDir/.claude/worktrees/agent-deadbeef
  const agentWtParent = path.join(featureDir, '.claude', 'worktrees');
  fs.mkdirSync(agentWtParent, { recursive: true });
  agentWtDir = path.join(agentWtParent, 'agent-deadbeef');
  git(upstreamDir, ['worktree', 'add', '-b', 'worktree-agent-deadbeef', agentWtDir]);

  // --- subdir inside agent worktree ---
  agentSubdir = path.join(agentWtDir, 'src', 'deep');
  fs.mkdirSync(agentSubdir, { recursive: true });

  // --- legitUnderClaude: non-agent worktree whose PATH is under .claude/worktrees/ ---
  // This proves the guard discriminates by branch name, not path.
  const legitParent = path.join(upstreamDir, '.claude', 'worktrees');
  fs.mkdirSync(legitParent, { recursive: true });
  legitUnderClaude = path.join(legitParent, 'legit-feature');
  git(upstreamDir, ['worktree', 'add', '-b', 'workspace/legit', legitUnderClaude]);
});

after(() => {
  // Prune stale worktree metadata before removing dirs
  try { git(upstreamDir, ['worktree', 'prune']); } catch (_) { /* best-effort */ }
  for (const d of dirsToCleanup) {
    try { cleanup(d); } catch (_) { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bug #48: orchestrator cwd-drift guard — executable e2e', () => {
  let guardBash;

  before(() => {
    guardBash = extractCwdGuardBash();
  });

  test('guard passes from a feature worktree on a non-agent branch (exit 0)', () => {
    const { status, stderr } = runGuard(guardBash, featureDir);
    assert.equal(
      status, 0,
      `Expected exit 0 from feature worktree, got ${status}. stderr: ${stderr}`,
    );
  });

  test('guard fails closed (exit 1) when cwd is inside an agent worktree', () => {
    const { status, stderr } = runGuard(guardBash, agentWtDir);
    assert.equal(
      status, 1,
      `Expected exit 1 from agent worktree, got ${status}. stderr: ${stderr}`,
    );
    assert.match(
      stderr,
      /agent worktree/i,
      `Expected stderr to mention "agent worktree", got: ${stderr}`,
    );
  });

  test('guard fails closed (exit 1) from a SUBDIRECTORY of an agent worktree (root resolution)', () => {
    // git rev-parse --show-toplevel resolves to the worktree root regardless of cwd subdir.
    // The guard must catch this via the branch-name check, not the path check.
    const { status, stderr } = runGuard(guardBash, agentSubdir);
    assert.equal(
      status, 1,
      `Expected exit 1 from agent worktree subdir, got ${status}. stderr: ${stderr}`,
    );
  });

  test('guard does NOT blanket-refuse a non-agent worktree located under .claude/worktrees/ (exit 0)', () => {
    // Discriminator is the worktree-agent-* branch namespace, NOT the path.
    const { status, stderr } = runGuard(guardBash, legitUnderClaude);
    assert.equal(
      status, 0,
      `Expected exit 0 from non-agent worktree under .claude/worktrees/, got ${status}. stderr: ${stderr}`,
    );
  });

  test('guard fails closed (exit 1) when not inside a git repo', (t) => {
    const nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-48-nongit-'));
    try {
      // Verify that git rev-parse --show-toplevel actually fails here.
      // On some systems /tmp itself might be inside a git repo (e.g. if the
      // user's HOME is a git repo). If it resolves, we must skip this test.
      const check = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: nonRepoDir,
        encoding: 'utf-8',
      });
      if (check.status === 0) {
        t.skip('nonRepoDir unexpectedly resolved to a git repo — skipping');
        return;
      }

      const { status, stderr } = runGuard(guardBash, nonRepoDir);
      assert.equal(
        status, 1,
        `Expected exit 1 when not inside a git repo, got ${status}. stderr: ${stderr}`,
      );
    } finally {
      try { cleanup(nonRepoDir); } catch (_) { /* best-effort */ }
    }
  });
});
