'use strict';

// The verifier harvests every `<verify><human-check>` block on an auto task, including one whose `<expected>`
// already records a verdict (#5741): Step 8 of agents/gsd-verifier.md, and the two planner-side references that
// state the same rule. Was tests/verifier-harvest-recorded-verdict.test.cjs.

module.exports = {
  id: 'verifier-harvest-recorded-verdict',
  issue: '#5741',
  check(ctx) {
    ctx.doc('agents/gsd-verifier.md')
      .slice('## Step 8: Identify Human Verification Needs', '\n## Step 9')
      .has(/recorded verdict[^\n]{0,500}is not a reason to omit/i, 'a recorded verdict in <expected> must not be a reason to omit the check')
      .has(/[Dd]eduplicate only against your own analysis/, "deduplication must be limited to overlap with the verifier's own analysis")
      .has(/<expected>[^\n]{0,500}unmodified/, '<expected> text must be carried through unmodified');

    ctx.doc('gsd-core/references/planner-human-verify-mode.md')
      .has('verifier (Step 8) harvests every `<verify><human-check>` block at end-of-phase, even when its `<expected>` already records a verdict', 'the planner-side reference must agree that harvest ignores a recorded verdict');
    ctx.doc('gsd-core/references/checkpoints.md')
      .has('verifier harvests every `<verify><human-check>` at end-of-phase (Step 8), even when its `<expected>` already records a verdict', 'checkpoints.md must agree that harvest ignores a recorded verdict');
  },
};
