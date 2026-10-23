'use strict';

/**
 * #4483: `gsd_run check predicate` resolves ${PHASE_DIR}/${PHASE_NUMBER}/${PHASE_REQ_IDS} in a
 * command-exit-zero gate from the --phase-dir/--phase-number/--phase-req-ids flags the calling
 * workflow passes. A dispatch line that omits a value the same workflow already holds makes a
 * capability gate silently resolve that placeholder to ''. These workflow dispatch lines are the
 * installed contract the orchestrating LLM follows, so the contract is asserted on the lines.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileNormalized } = require('./helpers.cjs');

const WF = path.join(__dirname, '..', 'gsd-core', 'workflows');

// [label, file parts, flags that must be on the dispatch line (the values the file holds live there)]
const DISPATCHES = [
  ['execute:post (verify-phase-goal)', ['execute-phase', 'steps', 'verify-phase-goal.md'], ['--phase-dir', '--phase-number']],
  ['plan-phase gate dispatch', ['plan-phase.md'], ['--phase-dir', '--phase-number', '--phase-req-ids']],
];

describe('#4483 check predicate dispatch passes every PHASE_* value the workflow holds', () => {
  for (const [label, parts, flags] of DISPATCHES) {
    test(`${label} passes ${flags.join(', ')}`, () => {
      const text = readFileNormalized(path.join(WF, ...parts));
      const lines = text.split('\n').filter((l) => l.includes('gsd_run check predicate'));
      assert.ok(lines.length >= 1, `${label}: no check predicate dispatch line found`);
      for (const line of lines) {
        for (const flag of flags) {
          assert.ok(line.includes(`${flag} "`), `${label}: dispatch omits ${flag}:\n${line.trim()}`);
        }
      }
    });
  }
});
