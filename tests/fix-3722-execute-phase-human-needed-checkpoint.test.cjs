// allow-test-rule: source-text-is-the-product
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
 *   - human_needed branch creates a UAT.md file (not HUMAN-UAT.md)
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
  'get-shit-done',
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
