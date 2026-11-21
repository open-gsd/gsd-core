'use strict';

// /gsd:autonomous --to N (#1644): stop after a specific phase completes. The command definition and the
// workflow document and parse the flag: TO_PHASE is empty unless `--to` is followed by a number, the
// iterate step halts only when it is set, a target already completed exits with a message, and the
// startup banner and success criteria name it. Was tests/autonomous-to-flag.test.cjs.

const COMMAND = 'commands/gsd/autonomous.md';
const WORKFLOW = 'gsd-core/workflows/autonomous.md';

module.exports = {
  id: 'autonomous-to-flag',
  issue: '#1644',
  check(ctx) {
    ctx.doc(COMMAND)
      .has(/^argument-hint:.*--to/m, 'argument-hint frontmatter should contain --to')
      .has('--to', 'command should document --to flag')
      .has(/stop|halt/, 'command should describe stopping behavior');

    const workflow = ctx.doc(WORKFLOW);
    workflow
      .has('--to', 'workflow should parse --to into TO_PHASE variable')
      .has('TO_PHASE', 'workflow should parse --to into TO_PHASE variable')
      // The grep requires a digit after --to, so a bare --to never activates TO_PHASE (no error needed).
      .has('\\-\\-to\\s+[0-9]', 'workflow grep pattern should require a digit after --to')
      .has('TO_PHASE=""', 'TO_PHASE should default to empty when --to is not provided or has no number')
      // The banner and the exit message themselves, not the success-criteria checklist that also names them.
      .has('If `TO_PHASE` is set, display: `Stopping after phase ${TO_PHASE}`', 'startup banner should display the --to target phase')
      .has('already completed. Nothing to do.', 'workflow should exit with a message when the --to target is already completed')
      // --to and --from are usable together; --to parsing must not swallow --only.
      .has('--from', 'workflow should support both --to and --from flags')
      .has(/ONLY_PHASE[\s\S]{0,200}--only/, '--only parsing should still be present and independent');

    // The iterate section: everything from the opening tag of the iterate step to the end of the file.
    workflow
      .slice('<step name="iterate">')
      .has('TO_PHASE', 'iterate step should check TO_PHASE to decide whether to continue and carry the --to completion message')
      .has(/If `TO_PHASE`|TO_PHASE" is set|TO_PHASE` is set/, 'iterate step should only halt when TO_PHASE is set (preserving default run-all behavior)');

    workflow
      .slice('<success_criteria>', '</success_criteria>')
      .has('--to', 'success criteria should include --to requirements');
  },
};
