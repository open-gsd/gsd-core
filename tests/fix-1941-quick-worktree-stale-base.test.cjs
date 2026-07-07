// allow-test-rule: source-text-is-the-product #1941
// Workflow .md files are the installed AI instructions — their text IS what the runtime
// loads. Testing text content tests the deployed contract. Per CONTRIBUTING.md exception matrix.

/**
 * Regression tests for bug #1941: /gsd-quick worktree executor forks from a stale base —
 * up to many commits behind, not just the one-commit gap #1265 already covers.
 *
 * Root cause: Claude Code's isolation="worktree" forks new worktrees from origin/HEAD, not
 * the live local HEAD. When prior local commits (e.g. earlier quick tasks in the same
 * session, or this task's own Step 5.6 pre-dispatch plan commit) advance local HEAD without
 * an intervening `git push`, origin/HEAD stays pinned to a stale ancestor and the executor's
 * worktree_branch_check guard halts with a base-mismatch fatal. The fix ports the
 * worktree.base-check auto-degrade pattern already used by execute-phase (#683/#1369) into
 * quick.md's single-dispatch path.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');

describe('quick: pre-dispatch worktree base re-check (#1941)', () => {
  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'workflows/quick.md should exist');
  });

  test('Step 6 runs worktree.base-check before capturing EXPECTED_BASE', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const step6Idx = content.indexOf('**Step 6: Spawn executor**');
    const baseCheckIdx = content.indexOf('worktree.base-check', step6Idx);
    const expectedBaseIdx = content.indexOf('EXPECTED_BASE=$(git rev-parse HEAD)', step6Idx);
    assert.ok(step6Idx !== -1, '"Step 6: Spawn executor" must exist in quick.md');
    assert.ok(baseCheckIdx !== -1, 'worktree.base-check must be invoked within Step 6');
    assert.ok(expectedBaseIdx !== -1, 'EXPECTED_BASE capture must exist within Step 6');
    assert.ok(
      baseCheckIdx < expectedBaseIdx,
      'worktree.base-check must run BEFORE EXPECTED_BASE is captured so the degrade decision reflects the most current local HEAD'
    );
  });

  test('degrade check references #1941 for traceability', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    assert.ok(content.includes('#1941'), 'quick.md must reference #1941');
  });

  test('degrade check sets USE_WORKTREES=false when shouldDegrade is true', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const baseCheckIdx = content.indexOf('worktree.base-check');
    const block = content.slice(baseCheckIdx, baseCheckIdx + 600);
    assert.ok(
      block.includes('shouldDegrade') && block.includes('USE_WORKTREES=false'),
      'degrade check must override USE_WORKTREES=false when shouldDegrade is true'
    );
  });

  test('degrade check guards on RUNTIME=claude (worktree isolation is Claude Code-specific)', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const baseCheckIdx = content.indexOf('worktree.base-check');
    const block = content.slice(Math.max(0, baseCheckIdx - 200), baseCheckIdx + 200);
    assert.ok(
      block.includes('RUNTIME') && (block.includes('"claude"') || block.includes("'claude'")),
      'degrade check must guard on RUNTIME=claude'
    );
  });

  test('degrade check names origin/HEAD as the stale fork base', () => {
    const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    const step6Idx = content.indexOf('**Step 6: Spawn executor**');
    const nextSection = content.indexOf('\n---', step6Idx);
    const section = content.slice(step6Idx, nextSection === -1 ? undefined : nextSection);
    assert.ok(section.includes('origin/HEAD'), 'Step 6 must name origin/HEAD as the stale fork base');
  });
});
