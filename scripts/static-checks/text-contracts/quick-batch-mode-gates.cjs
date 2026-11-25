'use strict';

// The quick-batch verification and research steps run only in their mode (#6532): each step file has a skip gate
// on the variable that `quick-batch.md` sets from `init.quick-batch`'s `modes`, ahead of the step's first Agent()
// dispatch. Pinned: a line starting "Skip this step" with "NOT `$VAR`" within 40 characters, placed before the first
// line that opens with `Agent(` (a mention of Agent() in prose does not count). The rest of the wording is free. The
// variables themselves are tested by running the shipped blocks (tests/gsd-quick-batch-modes.process.test.cjs).
// Was a row of tests/gsd-quick-batch-modes.test.cjs.

const STEPS = [
  ['gsd-core/workflows/quick-batch/steps/verification-wave.md', 'VALIDATE_MODE', 'verifier'],
  ['gsd-core/workflows/quick-batch/steps/research-phase.md', 'RESEARCH_MODE', 'researcher'],
];

const DISPATCH = '\nAgent(';

module.exports = {
  id: 'quick-batch-mode-gates',
  issue: '#6532',
  check(ctx) {
    for (const [rel, variable, agent] of STEPS) {
      const gate = new RegExp(`^Skip this step\\b[^\\n]{0,40}\\bNOT \`\\$${variable}\``, 'm');
      ctx.doc(rel)
        .has(gate, `the step must skip itself unless $${variable} is set`)
        .has(DISPATCH, `the step must dispatch its ${agent} with an Agent() call`)
        .satisfies((text) => {
          // A missing gate or dispatch is already a finding above.
          const at = text.search(gate);
          const dispatch = text.indexOf(DISPATCH);
          return at === -1 || dispatch === -1 || at < dispatch || 'the gate follows the dispatch';
        }, `the $${variable} gate must come before the first ${agent} Agent() dispatch`);
    }
  },
};
