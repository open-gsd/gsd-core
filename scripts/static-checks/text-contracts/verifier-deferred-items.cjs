'use strict';

// The verifier filters gaps that a later milestone phase addresses (#1624): gsd-verifier.md has Step 9b that
// cross-references the roadmap, a conditional `deferred:` frontmatter section with `addressed_in` and `evidence:`
// fields, a rule that deferred items do not affect the status, conservative matching, a Deferred Items table and a
// success criterion; planner-gap-closure.md skips deferred items, tells `gaps:` from `deferred:` and says deferred
// items are not actionable. The bare word `evidence` (everywhere in the verifier) is asked for as `evidence:`.
// Was tests/verifier-deferred-items.test.cjs.

module.exports = {
  id: 'verifier-deferred-items',
  issue: '#1624',
  check(ctx) {
    ctx.exists('agents/gsd-verifier.md', 'gsd-verifier.md should exist');
    ctx.doc('agents/gsd-verifier.md')
      .has(/Step 9b|Filter Deferred/, 'gsd-verifier.md should contain Step 9b or a "Filter Deferred" section')
      .has(/roadmap analyze|roadmap\.analyze/, 'Step 9b should reference roadmap analyze for loading full milestone data')
      .has('deferred:', 'the VERIFICATION.md template should include a deferred: section in frontmatter')
      .has('addressed_in', 'deferred items should include an addressed_in field referencing the later phase')
      .has('evidence:', 'deferred items should include an evidence field with matching goal/criteria')
      .has(/if deferred items exist|If deferred items exist|Only if deferred/, 'the deferred section should be conditional: only included when deferred items exist')
      .has(/do NOT affect the status|do not affect status|Deferred items do NOT affect/, 'the verifier should state that deferred items do not affect status')
      .has(/conservative|when in doubt/, 'the verifier should be conservative when matching gaps to later phases')
      .has('### Deferred Items', 'the report body template should include a Deferred Items section')
      .has(/Deferred items filtered|deferred items filtered|Deferred items structured/, 'the success criteria should reference deferred item filtering');

    ctx.exists('gsd-core/references/planner-gap-closure.md', 'planner-gap-closure.md should exist');
    ctx.doc('gsd-core/references/planner-gap-closure.md')
      .satisfies((text) => {
        const lower = text.toLowerCase();
        return (lower.includes('deferred') && lower.includes('skip')) || 'expected both "deferred" and "skip"';
      }, 'planner-gap-closure.md should mention skipping deferred items')
      .has('gaps:', 'planner-gap-closure.md should reference the gaps: section to distinguish it from deferred')
      .has('deferred:', 'planner-gap-closure.md should reference the deferred: section to distinguish it from gaps')
      .has(/NOT gaps|not gaps|must be ignored/, 'planner-gap-closure.md should explain that deferred items are not actionable gaps');
  },
};
