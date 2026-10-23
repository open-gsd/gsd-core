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
const fs = require('node:fs');
const path = require('node:path');
const { readFileNormalized } = require('./helpers.cjs');

const WF = path.join(__dirname, '..', 'gsd-core', 'workflows');

// [label, file parts, flag -> the live variable it must carry]. These are the values each file holds at
// its dispatch; verify-work.md holds only PHASE_DIR there (PHASE_NUMBER is first assigned after its
// verify:pre dispatch and PHASE_REQ_IDS is never assigned), and ship.md never assigns PHASE_REQ_IDS.
const DIR = ['--phase-dir', '${PHASE_DIR}'];
const NUM = ['--phase-number', '${PHASE_NUMBER}'];
const REQ = ['--phase-req-ids', '${PHASE_REQ_IDS}'];
const DISPATCHES = [
  ['execute:post (verify-phase-goal)', ['execute-phase', 'steps', 'verify-phase-goal.md'], [DIR, NUM]],
  ['plan-phase gate dispatch', ['plan-phase.md'], [DIR, NUM, REQ]],
  ['ship gate dispatch', ['ship.md'], [DIR, NUM]],
  ['verify-work verify:pre dispatch', ['verify-work.md'], [DIR]],
];

const dispatchLines = (text) => text.split('\n').filter((l) => l.includes('gsd_run check predicate'));

describe('#4483 check predicate dispatch passes every PHASE_* value the workflow holds', () => {
  for (const [label, parts, flags] of DISPATCHES) {
    test(`${label} passes ${flags.map(([f]) => f).join(', ')}`, () => {
      const lines = dispatchLines(readFileNormalized(path.join(WF, ...parts)));
      assert.ok(lines.length >= 1, `${label}: no check predicate dispatch line found`);
      for (const line of lines) {
        for (const [flag, value] of flags) {
          assert.ok(line.includes(`${flag} "${value}"`), `${label}: dispatch omits ${flag} "${value}":\n${line.trim()}`);
        }
      }
    });
  }

  test('no other workflow dispatches check predicate without being listed here', () => {
    const listed = new Set(DISPATCHES.map(([, parts]) => parts.join('/')));
    const unlisted = [];
    const walk = (dir, rel) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
        else if (entry.name.endsWith('.md') && !listed.has(relPath)
          && dispatchLines(readFileNormalized(path.join(dir, entry.name))).length > 0) unlisted.push(relPath);
      }
    };
    walk(WF, '');
    assert.deepEqual(unlisted, [], 'a new check predicate dispatch site must be added to DISPATCHES with the values it holds');
  });
});
