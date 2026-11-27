'use strict';

// The /gsd-next workflow's safety gates and prior-phase completeness scan (#1732, #2089, #2790): next.md has a
// safety_gates step between detect_state and determine_next_action with three hard stops (an unresolved
// .continue-here.md checkpoint, an error state in STATE.md, unchecked VERIFICATION.md failures), a prior-phase
// completeness scan that replaced the consecutive-call counter (plans without summaries, verification failures not
// overridden, CONTEXT.md without plans, the [C]/[S]/[F] choices, deferral to a 999.x backlog entry, a silent route when
// prior phases are clean), the --force bypass with its warning, and an exit on the first hit; progress.md, which absorbed
// the standalone command as the --next flag, documents --next, --force and the completeness routing. The test's second
// --force check repeated an earlier one and is not carried over. Was tests/next-safety-gates.test.cjs.

const WORKFLOW = 'gsd-core/workflows/next.md';
const COMMAND = 'commands/gsd/progress.md';

// The first `a` precedes the first `b`. A missing safety_gates step (the `b` of the first pair, the `a` of the second) is
// already one finding of its own, so that pair is skipped; any other missing marker is a finding of this assertion.
const inOrder = (a, b, gatesIs) => (text) => {
  const first = text.indexOf(a);
  const second = text.indexOf(b);
  if ((gatesIs === 1 ? second : first) === -1 && (gatesIs === 1 ? b : a).includes('safety_gates')) return true;
  return (first !== -1 && second !== -1 && first < second) || `expected the first ${a} before the first ${b}`;
};

module.exports = {
  id: 'next-safety-gates',
  issue: '#1732',
  check(ctx) {
    ctx.doc(WORKFLOW)
      .has('<step name="safety_gates">', 'workflow should have a safety_gates step')
      .satisfies(inOrder('name="detect_state"', 'name="safety_gates"', 1), 'safety_gates must appear after the detect_state step')
      .satisfies(inOrder('name="safety_gates"', 'name="determine_next_action"', 0), 'safety_gates must appear before the determine_next_action step')
      .has('.continue-here.md', 'Gate 1 should check for .planning/.continue-here.md')
      .has('Unresolved checkpoint', 'Gate 1 should display "Unresolved checkpoint" message')
      .has(/status: error|status: failed/, 'Gate 2 should check for error/failed status in STATE.md')
      .has('Project in error state', 'Gate 2 should display "Project in error state" message')
      .has('VERIFICATION.md', 'Gate 3 should check VERIFICATION.md')
      .has('FAIL', 'Gate 3 should look for FAIL items')
      .has('Unchecked verification failures', 'Gate 3 should display "Unchecked verification failures" message')
      .has('Prior-phase completeness scan', 'workflow should have a prior-phase completeness scan section')
      .lacks('.next-call-count', 'workflow must not reference the old .next-call-count counter file')
      .lacks('consecutively', 'workflow must not reference consecutive call counting')
      .has(/Plans without summaries|no SUMMARY\.md/, 'completeness scan should detect plans that ran without producing summaries')
      .has(/Verification failures not overridden|VERIFICATION\.md with `FAIL`/, 'completeness scan should detect unoverridden FAIL items in prior phase VERIFICATION.md')
      .has(/CONTEXT\.md without plans|CONTEXT\.md but no PLAN\.md/, 'completeness scan should detect phases with discussion but no planning')
      .has('[C]', 'completeness scan should offer [C] Continue option')
      .has('[S]', 'completeness scan should offer [S] Stop option')
      .has('[F]', 'completeness scan should offer [F] Force option')
      .has('999.', 'deferral should use the 999.x backlog numbering scheme')
      .has(/Backlog|BACKLOG/, 'deferral should write to the Backlog section of ROADMAP.md')
      .has(/silently|no interruption/, 'workflow should route without interruption when prior phases are clean')
      .has('--force', 'workflow should document --force flag')
      .has('skipping safety gates', 'workflow should print warning when --force is used')
      .has('Exit on first hit', 'safety gates should exit on first hit');

    // #2790: the standalone command was absorbed into progress.md as the --next flag; both safety-relevant contracts
    // (the --force escape hatch and the completeness routing) must survive there.
    ctx.doc(COMMAND)
      .has('--next', 'progress.md must document the --next flag (absorbed from the standalone next command in #2790)')
      .has('--force', 'progress.md must document the --force escape hatch for --next')
      .has(/completeness|next workflow|scans? all prior phases/i, 'progress.md must document the completeness scan / next-workflow routing for --next');
  },
};
