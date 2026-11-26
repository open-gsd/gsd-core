'use strict';

// /gsd:autonomous --interactive (#1413): the command definition and the workflow document the flag and
// its behavior (discuss inline, plan and execute as background agents, pipeline parallelism).
// Was tests/autonomous-interactive.test.cjs.

const COMMAND = 'commands/gsd/autonomous.md';
const WORKFLOW = 'gsd-core/workflows/autonomous.md';
const INTERACTIVE_BRANCH = '**If `INTERACTIVE` is set:**';

module.exports = {
  id: 'autonomous-interactive',
  issue: '#1413',
  check(ctx) {
    ctx.doc(COMMAND)
      .has(/^argument-hint:.*--interactive/m, 'argument-hint should include --interactive')
      .has('discuss', 'command should describe discuss running inline')
      .has('inline', 'command should describe discuss running inline')
      .has('background', 'command should mention background agents for plan+execute');

    const workflow = ctx.doc(WORKFLOW);
    workflow
      .has('--interactive', 'workflow should parse --interactive into INTERACTIVE variable')
      .has('INTERACTIVE', 'workflow should parse --interactive into INTERACTIVE variable');

    // Per #2697 the user-facing form is the hyphen invariant gsd-discuss-phase (the colon form was retired
    // and is held absent by the bug-2543 tests). The Skill call is searched only inside the structural
    // region that gates on INTERACTIVE: both tokens also appear in unrelated sections, so a whole-file
    // search would pass on a stray mention. The branch ends at the sibling `**If \`` marker or, failing
    // that, the next step boundary; whitespace around `(`, `skill` and `=` is tolerated.
    workflow
      .slice(INTERACTIVE_BRANCH, ['**If `INTERACTIVE` is NOT set', '**If `', '</step>', '<step '])
      .has(/Skill\(\s*skill\s*=\s*['"]gsd-discuss-phase['"]/, 'the INTERACTIVE branch must invoke Skill(skill="gsd-discuss-phase")');

    workflow
      .has('run_in_background', 'workflow should dispatch plan-phase as a background agent in interactive mode')
      .has('plan-phase', 'workflow should dispatch plan-phase as a background agent in interactive mode')
      .has('execute-phase', 'workflow should dispatch execute-phase as a background agent in interactive mode')
      .has(/pipeline parallelism|Phase N\+1/, 'workflow should describe overlapping discuss/execute between phases');

    workflow
      .slice('<success_criteria>', '</success_criteria>')
      .has('--interactive', 'success criteria should include --interactive requirements')
      .has('discuss inline', 'success criteria should mention discuss inline')
      .has('background agents', 'success criteria should mention background agents');
  },
};
