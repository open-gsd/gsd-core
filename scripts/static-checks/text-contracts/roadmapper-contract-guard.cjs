'use strict';

// gsd-roadmapper follows ONE contract, write-first (#3797): the approval gate belongs to the orchestrator, so the
// approve-first leftovers ("for approval", "Awaiting / Approve", a "## ROADMAP DRAFT" header, "(after approval)")
// must not return, while the write-first checklist line, Step 7 and the reactive Step 9 revision stay. Was
// tests/roadmapper-contract-guard.test.cjs.

module.exports = {
  id: 'roadmapper-contract-guard',
  issue: '#3797',
  check(ctx) {
    ctx.doc('agents/gsd-roadmapper.md')
      .lacks(/for (user )?approval/i, 'the agent cannot host a user approval loop: approve-first phrasing must not return')
      .lacks(/Awaiting \/ Approve/, 'the Awaiting / Approve output footer is the old contract')
      .lacks(/^## ROADMAP DRAFT/m, 'the agent returns ## ROADMAP CREATED: a DRAFT header matches no orchestrator branch')
      .has(/Files written immediately/, 'the checklist must pin the write-first ordering')
      .has(/^## Step 7: Write Files Immediately$/m, 'the write-first execution flow is the intended contract and must stay')
      .lacks(/\(after approval\)/, 'the checklist must not claim files are written after an approval the agent never hosts')
      .has(/^## Step 9: Handle Revision \(if needed\)$/m, 'reactive revision (Step 9) stays: it is the revision path under the write-first contract');
  },
};
