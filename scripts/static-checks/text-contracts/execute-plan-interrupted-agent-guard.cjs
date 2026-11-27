'use strict';

// execute-plan's interrupted-agent detection is reachable (#3795): the init_agent_tracking step once cleared
// `.planning/current-agent-id.txt` before the existence check that read it, so the interrupted-agent branch and
// the Task `resume` prompt could never run. The read precedes the clear. Was
// tests/execute-plan-interrupted-agent-guard.test.cjs.

const PROBE = '[ -f .planning/current-agent-id.txt ]';
const CLEAR = 'rm -f .planning/current-agent-id.txt';

module.exports = {
  id: 'execute-plan-interrupted-agent-guard',
  issue: '#3795',
  check(ctx) {
    ctx.doc('gsd-core/workflows/execute-plan.md')
      .step('init_agent_tracking')
      .has(PROBE, 'the step must probe for a surviving current-agent-id.txt')
      .has(CLEAR, 'the step must clear the stale id for the fresh run')
      .before(PROBE, CLEAR, 'the existence check must run BEFORE the rm: delete-first made the interrupted-agent branch and its Task resume prompt unreachable')
      .has(/INTERRUPTED_ID=\$\(/, 'the surviving id must be captured while the file still exists')
      .has(/resume/, 'the resume-or-fresh prompt the read enables must stay present');
  },
};
