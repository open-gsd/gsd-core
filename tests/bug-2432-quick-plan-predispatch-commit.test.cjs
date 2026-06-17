/**
 * Bug #2432: quick.md PLAN.md timing — worktree executor can't read PLAN.md
 *
 * The orchestrator must commit PLAN.md to the base branch BEFORE spawning the
 * worktree-isolated executor. Without this, the executor's first Read resolves
 * to a main-repo absolute path (not a worktree path), which primes CC's path
 * cache and causes subsequent Edit/Write calls to silently target the main repo
 * instead of the worktree (CC issue #36182 amplifier).
 *
 * Fix: Step 5.6 commits PLAN.md pre-dispatch when USE_WORKTREES is active.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const QUICK_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');

describe('quick.md pre-dispatch PLAN.md commit (#2432)', () => {
  let content;

  test('quick.md exists', () => {
    assert.ok(fs.existsSync(QUICK_MD), 'gsd-core/workflows/quick.md must exist');
    content = fs.readFileSync(QUICK_MD, 'utf-8');
  });

  test('Step 5.6 exists between Step 5.5 and Step 6', () => {
    const step55 = content.indexOf('Step 5.5');
    const step56 = content.indexOf('Step 5.6');
    const step6  = content.indexOf('Step 6:');
    assert.ok(step55 !== -1, 'Step 5.5 must exist');
    assert.ok(step56 !== -1, 'Step 5.6 must exist');
    assert.ok(step6  !== -1, 'Step 6 must exist');
    assert.ok(step56 > step55, 'Step 5.6 must appear after Step 5.5');
    assert.ok(step56 < step6,  'Step 5.6 must appear before Step 6');
  });

  test('Step 5.6 is gated on USE_WORKTREES', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start  = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    assert.ok(
      step56Block.includes('USE_WORKTREES'),
      'Step 5.6 must be gated on USE_WORKTREES — only commit pre-dispatch in worktree mode'
    );
  });

  test('Step 5.6 is gated on commit_docs', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start  = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    assert.ok(
      step56Block.includes('commit_docs'),
      'Step 5.6 must respect commit_docs config — skip pre-dispatch commit when commit_docs is false'
    );
  });

  test('Step 5.6 stages and commits PLAN.md', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start  = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    assert.ok(
      step56Block.includes('PLAN.md'),
      'Step 5.6 must reference PLAN.md in the pre-dispatch commit'
    );
    assert.ok(
      step56Block.includes('git add') || step56Block.includes('git commit'),
      'Step 5.6 must include git add/commit to stage and commit PLAN.md'
    );
  });

  test('Step 5.6 uses --no-verify to avoid hook interference', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start  = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    assert.ok(
      step56Block.includes('--no-verify'),
      'Step 5.6 pre-dispatch commit must use --no-verify to avoid hook interference'
    );
  });

  test('executor prompt references PLAN.md via relative (worktree-rooted) path', () => {
    // QUICK_DIR is always set to ".planning/quick/..." (relative) so ${QUICK_DIR}/...PLAN.md
    // resolves relative to the worktree root, not the main repo absolute path.
    // Verify the executor prompt uses QUICK_DIR variable (not a hardcoded absolute path).
    const executorTask = content.indexOf('subagent_type="gsd-executor"');
    assert.ok(executorTask !== -1, 'executor Task() spawn must exist');
    // Find the files_to_read block near the executor spawn
    const filesBlock = content.lastIndexOf('<files_to_read>', executorTask);
    const filesBlockEnd = content.indexOf('</files_to_read>', filesBlock);
    const filesContent = content.slice(filesBlock, filesBlockEnd);
    assert.ok(
      filesContent.includes('QUICK_DIR') || filesContent.includes('.planning/quick'),
      'executor files_to_read must reference PLAN.md via relative QUICK_DIR path'
    );
    assert.ok(
      !filesContent.match(/\/home\/|\/Users\/|\/root\//),
      'executor files_to_read must NOT contain hardcoded absolute paths'
    );
  });

  test('#1265 records both parent base and plan commit for worktree dispatch', () => {
    const step56Start = content.indexOf('Step 5.6');
    const step6Start = content.indexOf('Step 6:', step56Start);
    const step56Block = content.slice(step56Start, step6Start);
    const step6Block = content.slice(step6Start, content.indexOf('After executor returns:', step6Start));

    assert.ok(
      step56Block.includes('QUICK_PLAN_PARENT'),
      'quick worktree mode must record the pre-dispatch parent SHA before committing PLAN.md (#1265)'
    );
    assert.ok(
      step56Block.includes('QUICK_PLAN_COMMIT'),
      'quick worktree mode must record the PLAN.md commit SHA after the pre-dispatch commit (#1265)'
    );
    assert.ok(
      step6Block.includes('EXPECTED_BASE_ALTERNATE'),
      'executor guard embed must carry the alternate accepted base for parent-vs-plan worktree forks (#1265)'
    );
  });

  test('#1265 executor materializes PLAN.md from the plan commit when worktree starts at parent', () => {
    const executorTask = content.indexOf('subagent_type="gsd-executor"');
    assert.ok(executorTask !== -1, 'executor Task() spawn must exist');
    const promptStart = content.lastIndexOf('prompt="', executorTask);
    const promptEnd = content.indexOf('subagent_type="gsd-executor"', promptStart);
    const executorPrompt = content.slice(promptStart, promptEnd);

    assert.ok(
      executorPrompt.includes('git show') && executorPrompt.includes('QUICK_PLAN_COMMIT'),
      'executor prompt must materialize PLAN.md from git show <plan-commit>:<plan-path> when absent (#1265)'
    );
    assert.ok(
      executorPrompt.indexOf('git show') < executorPrompt.indexOf('<files_to_read>'),
      'PLAN.md materialization must be a first action before files_to_read can prime paths (#1265)'
    );
  });
});
