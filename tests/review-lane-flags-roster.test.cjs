'use strict';

/**
 * review-lane-flags-roster.test.cjs
 *
 * The convergence workflows no longer list the reviewer lane flags: the text contracts
 * (scripts/static-checks/text-contracts/adr-15-progress-converge.cjs and autonomous-converge.cjs)
 * forbid a hand-listed copy, and `gsd_run review-lane flags` derives them. This is the behavioral
 * half: the roster the workflows derive from really yields the flags they used to hardcode, so the
 * derivation is not vacuous. It runs the command, so it is a test and not a static check.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTempProject, cleanup, runGsdToolsAsync } = require('./helpers.cjs');
const { FORMERLY_HARDCODED_LANE_FLAGS } = require('../scripts/static-checks/text-contracts/lib/converge-flags.cjs');

test('review-lane flags yields every reviewer lane flag the convergence workflows used to hand-list', async (t) => {
  const tmpDir = createTempProject();
  t.after(() => cleanup(tmpDir));
  const result = await runGsdToolsAsync(['review-lane', 'flags'], tmpDir);
  assert.equal(result.success, true, `review-lane flags failed: ${result.error}`);
  const laneFlags = result.output.split('\n').filter(Boolean);
  for (const flag of FORMERLY_HARDCODED_LANE_FLAGS) {
    assert.ok(laneFlags.includes(flag), `review-lane flags should include ${flag}`);
  }
});
