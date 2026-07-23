// allow-test-rule: source-text-is-the-product
// The workflow .md file is the installed AI contract — its text IS what the orchestrator
// executes at runtime. Testing structural content of step 5.5 guards against accidental
// deletion of the cross-wave-deviation cleanup documentation (#3264).

/**
 * Regression tests for #3264: cross-wave-dependency deviation cleanup documentation
 *
 * Guards that step 5.5 of execute-phase.md documents both skip conditions and
 * contains a self-contained cleanup-tail snippet for the deviation path.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'execute-phase.md',
);

/**
 * Locate the step 5.5 block in the workflow file.
 * Returns the substring from "5.5." up to (but not including) "5.6.".
 * Throws if the block cannot be found.
 */
function extractStep55Block(content) {
  const start = content.indexOf('\n5.5.');
  assert.ok(start !== -1, 'execute-phase.md must contain a step 5.5 block');

  const end = content.indexOf('\n5.6.', start + 1);
  assert.ok(end !== -1, 'execute-phase.md must contain a step 5.6 block after 5.5');

  return content.slice(start, end);
}

describe('execute-phase step 5.5: cross-wave-deviation cleanup documentation (#3264)', () => {
  function readWorkflow() {
    try {
      return fs.readFileSync(WORKFLOW_PATH, 'utf-8');
    } catch (err) {
      throw new Error(`failed to read workflow fixture at ${WORKFLOW_PATH}: ${err.message}`);
    }
  }

  test('workflow file exists', () => {
    assert.ok(fs.existsSync(WORKFLOW_PATH), 'workflows/execute-phase.md should exist');
  });

  test('step 5.5 block exists and is bounded', () => {
    // extractStep55Block throws on failure — this test validates the helper itself
    const content = readWorkflow();
    const block = extractStep55Block(content);
    assert.ok(block.length > 0, 'step 5.5 block must be non-empty');
  });

  test('step 5.5 documents the standard wave contract', () => {
    const content = readWorkflow();
    const block = extractStep55Block(content);
    assert.ok(
      block.includes('Standard wave contract'),
      'step 5.5 must name the standard wave contract explicitly',
    );
  });

  test('step 5.5 names cross-wave dependency deviation as a supported execution mode', () => {
    const content = readWorkflow();
    const block = extractStep55Block(content);
    assert.ok(
      block.includes('Cross-wave dependency deviation'),
      'step 5.5 must name the cross-wave dependency deviation as a supported mode',
    );
  });

  test('cleanup-tail snippet contains git worktree prune', () => {
    const content = readWorkflow();
    const block = extractStep55Block(content);
    assert.ok(
      block.includes('git worktree prune'),
      'step 5.5 cleanup-tail snippet must include git worktree prune',
    );
  });

  test('cleanup-tail snippet contains git worktree remove --force', () => {
    const content = readWorkflow();
    const block = extractStep55Block(content);
    assert.ok(
      block.includes('git worktree remove') && block.includes('--force'),
      'step 5.5 cleanup-tail snippet must include git worktree remove --force',
    );
  });

  test('cleanup-tail snippet contains git worktree unlock', () => {
    const content = readWorkflow();
    const block = extractStep55Block(content);
    assert.ok(
      block.includes('git worktree unlock'),
      'step 5.5 cleanup-tail snippet must include git worktree unlock',
    );
  });

  test('cleanup-tail snippet contains git branch -D', () => {
    const content = readWorkflow();
    const block = extractStep55Block(content);
    assert.ok(
      block.includes('git branch -D'),
      'step 5.5 cleanup-tail snippet must include git branch -D',
    );
  });

  test('skip conditions enumerate empty-WAVE_WORKTREE_PLANS case', () => {
    const content = readWorkflow();
    const block = extractStep55Block(content);
    assert.ok(
      block.includes('WAVE_WORKTREE_PLANS'),
      'step 5.5 must document the empty-WAVE_WORKTREE_PLANS skip condition',
    );
  });

  test('skip conditions enumerate custom-merge-deviation case', () => {
    const content = readWorkflow();
    const block = extractStep55Block(content);
    // The deviation skip condition must reference the cleanup-tail as the alternative
    assert.ok(
      block.includes('cleanup-tail'),
      'step 5.5 must document the custom-merge-deviation skip condition with a pointer to the cleanup-tail',
    );
  });

  test('cleanup-tail uses wave manifest instead of agent namespace discovery', () => {
    const content = readWorkflow();
    const block = extractStep55Block(content);
    assert.ok(
      block.includes('WAVE_WORKTREE_MANIFEST'),
      'cleanup-tail must consume the current wave manifest',
    );
    assert.ok(
      block.includes('avoid touching unrelated active agents'),
      'cleanup-tail must document why manifest-scoped cleanup is required',
    );
  });

  test('cleanup-tail does not rediscover global agent worktrees', () => {
    const content = readWorkflow();
    const block = extractStep55Block(content);
    assert.doesNotMatch(
      block,
      /git worktree list --porcelain.*\.claude\/worktrees\/agent-/s,
      'cleanup-tail must not parse global git worktree list output for agent worktrees',
    );
    assert.ok(
      block.includes('IFS= read -r'),
      'cleanup-tail still reads manifest paths line-by-line to preserve paths with whitespace',
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-3722-execute-phase-human-needed-checkpoint.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-3722-execute-phase-human-needed-checkpoint (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #3722)
// execute-phase.md IS the runtime contract loaded by the orchestrator.
// Asserting that the "ack-and-advance" path is absent is the only way to verify
// the state machine lie (issue #38) cannot regress at runtime.
'use strict';

/**
 * execute-phase.md human_needed branch — issue #38 / fix #3722
 *
 * The old design offered '"approved" → continue' as a shortcut that advanced
 * ROADMAP.md without completing human verification. This is a state machine lie:
 * the phase appears complete in the project record while HUMAN-UAT.md items
 * remain unresolved.
 *
 * The correct design:
 *   - human_needed branch creates a {phase_num}-UAT.md file (not {phase_num}-HUMAN-UAT.md)
 *   - directs the user to /gsd:verify-work to complete verification
 *   - does NOT call update_roadmap directly (phase completion goes through verify-work)
 *   - does NOT offer "approved" → continue as a bypass
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const EXECUTE_PHASE = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'execute-phase.md'
);

describe('execute-phase.md human_needed branch — issue #38', () => {
  let content;

  // Read once; all tests share the string.
  test('workflow file is readable', () => {
    content = fs.readFileSync(EXECUTE_PHASE, 'utf-8');
    assert.ok(content.length > 0, 'execute-phase.md must be non-empty');
  });

  test('human_needed section exists', () => {
    if (!content) content = fs.readFileSync(EXECUTE_PHASE, 'utf-8');
    assert.ok(
      content.includes('human_needed'),
      'execute-phase.md must contain a human_needed branch'
    );
  });

  test('"approved" → continue bypass is absent from human_needed branch', () => {
    if (!content) content = fs.readFileSync(EXECUTE_PHASE, 'utf-8');
    // The old prompt offered '"approved" → continue' as a shortcut that advanced
    // ROADMAP.md without completing verification. That path must not exist.
    assert.ok(
      !content.includes('"approved" → continue'),
      'human_needed branch must not offer "approved" → continue: it marks the phase complete without verification (issue #38)'
    );
  });

  test('human_needed branch does NOT call update_roadmap directly', () => {
    if (!content) content = fs.readFileSync(EXECUTE_PHASE, 'utf-8');
    // Locate the human_needed section and check that update_roadmap does not
    // appear before the gaps_found section (i.e. it is not reachable from human_needed).
    const humanNeededIdx = content.indexOf('**If human_needed:**');
    const gapsFoundIdx = content.indexOf('**If gaps_found:**');
    const updateRoadmapIdx = content.indexOf('update_roadmap', humanNeededIdx);

    assert.ok(humanNeededIdx !== -1, '**If human_needed:** section must exist');
    assert.ok(gapsFoundIdx !== -1, '**If gaps_found:** section must exist');
    assert.ok(
      humanNeededIdx < gapsFoundIdx,
      'human_needed section must appear before gaps_found section'
    );

    // update_roadmap must not appear between human_needed and gaps_found sections
    const updateRoadmapBetween =
      updateRoadmapIdx !== -1 &&
      updateRoadmapIdx > humanNeededIdx &&
      updateRoadmapIdx < gapsFoundIdx;

    assert.ok(
      !updateRoadmapBetween,
      'update_roadmap must not be reachable directly from the human_needed branch — phase completion must go through verify-work (issue #38)'
    );
  });

  test('human_needed branch directs user to /gsd:verify-work', () => {
    if (!content) content = fs.readFileSync(EXECUTE_PHASE, 'utf-8');
    const humanNeededIdx = content.indexOf('**If human_needed:**');
    const gapsFoundIdx = content.indexOf('**If gaps_found:**');
    assert.ok(humanNeededIdx !== -1, '**If human_needed:** section must exist');

    const humanNeededSection = content.slice(
      humanNeededIdx,
      gapsFoundIdx !== -1 ? gapsFoundIdx : undefined
    );
    assert.ok(
      humanNeededSection.includes('verify-work'),
      'human_needed branch must direct the user to /gsd:verify-work to complete verification'
    );
  });

  test('human_needed branch creates {phase_num}-UAT.md (not HUMAN-UAT.md)', () => {
    if (!content) content = fs.readFileSync(EXECUTE_PHASE, 'utf-8');
    const humanNeededIdx = content.indexOf('**If human_needed:**');
    const gapsFoundIdx = content.indexOf('**If gaps_found:**');
    assert.ok(humanNeededIdx !== -1, '**If human_needed:** section must exist');

    const humanNeededSection = content.slice(
      humanNeededIdx,
      gapsFoundIdx !== -1 ? gapsFoundIdx : undefined
    );

    // The file should be named {phase_num}-UAT.md so verify-work's glob picks it up
    assert.ok(
      humanNeededSection.includes('-UAT.md'),
      'human_needed branch must create a {phase_num}-UAT.md file for verify-work to resume'
    );

    // HUMAN-UAT.md causes a naming mismatch with verify-work's create_uat_file step
    assert.ok(
      !humanNeededSection.includes('HUMAN-UAT.md'),
      'human_needed branch must NOT create HUMAN-UAT.md — use {phase_num}-UAT.md to align with verify-work\'s resume path (issue #38 edge case 3)'
    );
  });
});
  });
}
