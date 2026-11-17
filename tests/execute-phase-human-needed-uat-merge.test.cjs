'use strict';

/**
 * #5845: verify_phase_goal's human_needed Step A must merge-or-skip, never
 * overwrite an existing {phase_num}-UAT.md that holds a human's recorded
 * results. The workflow is agent-followed prose, so the contract is locked
 * on the Step A block of the shipped workflow.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');

function stepABlock() {
  const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
  const start = content.indexOf('**Step A: Persist human verification items');
  assert.notEqual(start, -1, 'execute-phase.md must contain human_needed Step A');
  const end = content.indexOf('**Step B: Present to user**', start);
  assert.notEqual(end, -1, 'execute-phase.md must contain Step B after Step A');
  return content.slice(start, end);
}

describe('execute-phase human_needed Step A: merge-or-skip (#5845)', () => {
  test('Step A checks for an existing UAT file before creating one', () => {
    const block = stepABlock();
    const guard = block.indexOf('test -f');
    const template = block.indexOf('status: testing');
    assert.notEqual(guard, -1, 'Step A must run a literal `test -f` existence check');
    assert.notEqual(template, -1, 'Step A must still carry the template');
    assert.ok(guard < template, 'existence check must precede the create-from-template block');
  });

  test('existing file keeps recorded results, status and started', () => {
    const block = stepABlock();
    assert.match(block, /keep every recorded result/i);
    assert.match(block, /Keep `status` and `started` unchanged/);
    assert.match(block, /never (reset|overwrite|replace)/i);
  });

  test('appends only items absent by description as pending', () => {
    const block = stepABlock();
    assert.match(block, /not already present/i);
    assert.match(block, /matched by description/i);
    assert.match(block, /result: \[pending\]/);
  });

  test('recomputes Summary counts from the merged list', () => {
    assert.match(stepABlock(), /recompute the `## Summary` counts/i);
  });

  test('no write or commit when nothing to append', () => {
    assert.match(stepABlock(), /nothing to append[^.]*(no write|do not write|skip)[^.]*commit/i);
  });

  test('absent file still creates the template and commits with the original message', () => {
    const block = stepABlock();
    assert.match(block, /status: testing/);
    assert.match(block, /passed: 0/);
    assert.ok(block.includes('test({phase_num}): persist human verification items as UAT'));
  });

  test('never instructs renaming the old file aside', () => {
    const block = stepABlock();
    assert.doesNotMatch(block, /^\s*(git\s+)?mv\s/m);
    assert.match(block, /do not rename/i);
  });
});
