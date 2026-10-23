'use strict';

/**
 * #5578: a plan-checker return of `## VERIFICATION PASSED` that still lists a
 * BLOCKER or WARNING entry must be handled as `## ISSUES FOUND`. plan-phase step 11,
 * quick and quick-batch plan-checker-loop and verify-work routed on the sentinel
 * alone, so a PASSED-with-warnings return skipped the revision loop and plans with
 * known blockers reached execute-phase. import.md already counted by severity; its
 * PASSED branch is aligned here.
 *
 * Workflow Markdown is the installed orchestration contract an LLM follows, so the
 * contract is asserted on the prose of the PASSED branch in each consumer.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileNormalized } = require('./helpers.cjs');

const WF = path.join(__dirname, '..', 'gsd-core', 'workflows');
const CONSUMERS = [
  ['plan-phase step 11', ['plan-phase.md'], /marker_received[^\n]*VERIFICATION PASSED[^\n]*\n?/],
  ['quick plan-checker-loop', ['quick', 'steps', 'plan-checker-loop.md'], /^- \*\*`## VERIFICATION PASSED`:\*\*[^\n]*/m],
  ['quick-batch plan-checker-loop', ['quick-batch', 'steps', 'plan-checker-loop.md'], /^- \*\*`## VERIFICATION PASSED` that nevertheless[^\n]*/m],
  ['verify-work', ['verify-work.md'], /^- \*\*VERIFICATION PASSED:\*\*[^\n]*/m],
  ['import', ['import.md'], /Handle the checker return by severity[^\n]*/],
];

describe('#5578 a PASSED checker return that lists BLOCKER/WARNING entries is ISSUES FOUND', () => {
  for (const [name, parts, branch] of CONSUMERS) {
    test(`${name} does not route on the sentinel alone`, () => {
      const text = readFileNormalized(path.join(WF, ...parts));
      const m = branch.exec(text);
      assert.ok(m, `${name}: could not locate the VERIFICATION PASSED branch`);
      const passed = m[0];
      assert.match(passed, /BLOCKER or WARNING/, `${name}: PASSED branch must name BLOCKER/WARNING entries`);
      assert.match(passed, /ISSUES FOUND/, `${name}: PASSED + findings must be handled as ISSUES FOUND`);
      assert.match(passed, /prose/, `${name}: findings listed in prose must count, not only a YAML block`);
      assert.match(passed, /#5578/, `${name}: branch must cite the issue`);
    });
  }

  test('plan-phase step 12 does not accept a PASSED return on "no YAML block" or the sentinel alone', () => {
    const text = readFileNormalized(path.join(WF, 'plan-phase.md'));
    const count = /^Parse issue count from checker return:[^\n]*/m.exec(text);
    assert.ok(count, 'could not locate step 12 issue-count rule');
    assert.match(count[0], /lists no BLOCKER or WARNING entry in prose/);
    const recount = /^Recount BLOCKER \+ WARNING by the same rule[^\n]*/m.exec(text);
    assert.ok(recount, 'could not locate the iteration-limit recount rule');
    assert.match(recount[0], /PASSED with no BLOCKER\/WARNING entry/);
  });
});
