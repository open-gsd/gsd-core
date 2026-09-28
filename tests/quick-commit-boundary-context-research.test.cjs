/**
 * Regression test for #4996
 *
 * In `workflow.use_worktrees: true` mode, Step 5.6
 * (`gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md`) committed only
 * `<quick_id>-PLAN.md` into the worktree, and the executor's materialization fallback
 * in `gsd-core/workflows/quick.md` restored only `<quick_id>-PLAN.md` — so
 * `<quick_id>-CONTEXT.md` ("locked decisions") and `<quick_id>-RESEARCH.md` never
 * reached the executor in harness-worktree mode, even though the planner's
 * required_reading already listed both conditionally on $DISCUSS_MODE/$RESEARCH_MODE.
 *
 * Fix: Step 5.6 stages/commits CONTEXT.md/RESEARCH.md alongside PLAN.md (gated on
 * mode flag AND file existence, mirroring Step 8's file-list pattern), the executor's
 * materialization fallback restores them from the same pre-dispatch commit, and the
 * executor's required_reading lists them conditionally — matching the planner.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const QUICK_MD = path.join(WORKFLOWS_DIR, 'quick.md');
const PRE_DISPATCH_COMMIT_STEP = path.join(
  WORKFLOWS_DIR,
  'quick',
  'steps',
  'worktree-pre-dispatch-commit.md'
);

describe('#4996: worktree-pre-dispatch-commit.md covers CONTEXT.md/RESEARCH.md', () => {
  let content;

  test('step file exists', () => {
    assert.ok(
      fs.existsSync(PRE_DISPATCH_COMMIT_STEP),
      'gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md must exist'
    );
    content = fs.readFileSync(PRE_DISPATCH_COMMIT_STEP, 'utf-8');
  });

  test('stage/commit step is gated on DISCUSS_MODE for CONTEXT.md', () => {
    assert.ok(
      /DISCUSS_MODE/.test(content) && content.includes('CONTEXT.md'),
      'Step 5.6 must reference DISCUSS_MODE and CONTEXT.md so the pre-dispatch commit ' +
        'stages CONTEXT.md when the discussion phase ran (#4996)'
    );
  });

  test('stage/commit step is gated on RESEARCH_MODE for RESEARCH.md', () => {
    assert.ok(
      /RESEARCH_MODE/.test(content) && content.includes('RESEARCH.md'),
      'Step 5.6 must reference RESEARCH_MODE and RESEARCH.md so the pre-dispatch commit ' +
        'stages RESEARCH.md when the research phase ran (#4996)'
    );
  });

  test('CONTEXT.md/RESEARCH.md staging is also gated on file existence', () => {
    // Mirrors Step 8's "if $DISCUSS_MODE and context file exists" pattern — a mode
    // flag alone is not proof the file was actually written (#4996 explicitly calls
    // out that CONTEXT/RESEARCH are conditional and must not be required when never
    // created).
    const contextIdx = content.indexOf('CONTEXT.md');
    const researchIdx = content.indexOf('RESEARCH.md');
    assert.notEqual(contextIdx, -1, 'CONTEXT.md must be mentioned');
    assert.notEqual(researchIdx, -1, 'RESEARCH.md must be mentioned');
    assert.ok(
      /-f\s+"[^"]*CONTEXT\.md"/.test(content) || /\[ -f .*CONTEXT\.md/.test(content),
      'CONTEXT.md staging must be guarded by a file-existence test, not mode alone (#4996)'
    );
    assert.ok(
      /-f\s+"[^"]*RESEARCH\.md"/.test(content) || /\[ -f .*RESEARCH\.md/.test(content),
      'RESEARCH.md staging must be guarded by a file-existence test, not mode alone (#4996)'
    );
  });

  test('PLAN.md remains unconditionally staged (regression: PLAN-only path stays green)', () => {
    assert.ok(
      content.includes('PLAN.md'),
      'Step 5.6 must still reference PLAN.md unconditionally'
    );
  });
});

describe('#4996: quick.md executor materializes and reads CONTEXT.md/RESEARCH.md', () => {
  let content;

  test('quick.md exists', () => {
    assert.ok(fs.existsSync(QUICK_MD), 'gsd-core/workflows/quick.md must exist');
    content = fs.readFileSync(QUICK_MD, 'utf-8');
  });

  test('executor required_reading lists CONTEXT.md/RESEARCH.md conditionally, like the planner', () => {
    const executorTaskIdx = content.indexOf('subagent_type="gsd-executor"');
    assert.ok(executorTaskIdx !== -1, 'executor Agent()/Task() spawn must exist');
    const filesBlockStart = content.lastIndexOf('<required_reading>', executorTaskIdx);
    const filesBlockEnd = content.indexOf('</required_reading>', filesBlockStart);
    assert.ok(filesBlockStart !== -1 && filesBlockEnd !== -1, 'executor required_reading block must exist');
    const filesContent = content.slice(filesBlockStart, filesBlockEnd);

    assert.ok(
      filesContent.includes('DISCUSS_MODE') && filesContent.includes('CONTEXT.md'),
      'executor required_reading must list CONTEXT.md conditionally on $DISCUSS_MODE, ' +
        'matching the planner required_reading (#4996)'
    );
    assert.ok(
      filesContent.includes('RESEARCH_MODE') && filesContent.includes('RESEARCH.md'),
      'executor required_reading must list RESEARCH.md conditionally on $RESEARCH_MODE, ' +
        'matching the planner required_reading (#4996)'
    );
  });

  test('materialization fallback restores CONTEXT.md/RESEARCH.md from the pre-dispatch commit', () => {
    const executorTaskIdx = content.indexOf('subagent_type="gsd-executor"');
    const promptStart = content.lastIndexOf('prompt="', executorTaskIdx);
    const promptEnd = content.indexOf('subagent_type="gsd-executor"', promptStart);
    const executorPrompt = content.slice(promptStart, promptEnd);

    assert.ok(
      executorPrompt.includes('QUICK_PLAN_COMMIT') &&
        /CONTEXT\.md/.test(executorPrompt) &&
        executorPrompt.indexOf('git show') < executorPrompt.indexOf('<required_reading>'),
      'executor prompt must materialize CONTEXT.md from QUICK_PLAN_COMMIT before ' +
        'required_reading can prime paths, the same way it already does for PLAN.md (#4996)'
    );
    assert.ok(
      executorPrompt.includes('QUICK_PLAN_COMMIT') && /RESEARCH\.md/.test(executorPrompt),
      'executor prompt must materialize RESEARCH.md from QUICK_PLAN_COMMIT the same way ' +
        'it already does for PLAN.md (#4996)'
    );
  });

  test('PLAN.md materialization remains present (regression: PLAN-only path stays green)', () => {
    const executorTaskIdx = content.indexOf('subagent_type="gsd-executor"');
    const promptStart = content.lastIndexOf('prompt="', executorTaskIdx);
    const promptEnd = content.indexOf('subagent_type="gsd-executor"', promptStart);
    const executorPrompt = content.slice(promptStart, promptEnd);
    assert.ok(
      executorPrompt.includes('git show') && executorPrompt.includes('QUICK_PLAN_COMMIT'),
      'PLAN.md materialization via git show <plan-commit>:<plan-path> must remain (#1265, #4996)'
    );
  });
});
