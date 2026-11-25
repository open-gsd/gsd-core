'use strict';

// discuss-phase saves incremental checkpoints so a session interruption does not lose answers (#1485).
// After the progressive-disclosure split (#717) the checkpoint logic lives in modes/default.md and
// the JSON schema in templates/checkpoint.json, so most assertions read the union of the three files.
// Was tests/discuss-checkpoint.test.cjs.

const WORKFLOW = 'gsd-core/workflows/discuss-phase.md';
const DEFAULT_MODE = 'gsd-core/workflows/discuss-phase/modes/default.md';
const CHECKPOINT_TEMPLATE = 'gsd-core/workflows/discuss-phase/templates/checkpoint.json';

module.exports = {
  id: 'discuss-checkpoint',
  issue: '#1485',
  check(ctx) {
    ctx.docs([WORKFLOW, DEFAULT_MODE, CHECKPOINT_TEMPLATE])
      .has('DISCUSS-CHECKPOINT.json', 'workflow should reference checkpoint JSON file')
      .has(/Incremental checkpoint|incremental checkpoint/, 'workflow should describe incremental checkpoint saves')
      .has('areas_completed', 'checkpoint should track completed areas')
      .has('areas_remaining', 'checkpoint should track remaining areas')
      .has('"decisions"', 'checkpoint should include decisions object')
      .has('Resume', 'check_existing should detect checkpoint and offer resume');

    const workflow = ctx.doc(WORKFLOW)
      .has('rm -f', 'checkpoint file should be deleted after successful write_context')
      .has('DISCUSS-CHECKPOINT', 'checkpoint file should be deleted after successful write_context')
      .has(/auto-resolves|--auto/, 'checkpoint logic should apply to both interactive and auto modes');

    workflow
      .slice('<success_criteria>', '</success_criteria>')
      .has(/checkpoint|Checkpoint/, 'success criteria should mention checkpoints')
      .has(/resume|Resume/, 'success criteria should mention session resume capability');
  },
};
