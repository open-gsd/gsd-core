'use strict';

// The quick-batch verification and research steps run only in their mode (#6532): each step file opens with a
// skip gate on the variable that `quick-batch.md` sets from `init.quick-batch`'s `modes`, ahead of the step's
// first Agent() dispatch. The variables themselves are tested by running the shipped blocks
// (tests/gsd-quick-batch-modes.process.test.cjs). Was a row of tests/gsd-quick-batch-modes.test.cjs.

const STEPS = [
  ['gsd-core/workflows/quick-batch/steps/verification-wave.md', 'VALIDATE_MODE', 'verifier'],
  ['gsd-core/workflows/quick-batch/steps/research-phase.md', 'RESEARCH_MODE', 'researcher'],
];

module.exports = {
  id: 'quick-batch-mode-gates',
  issue: '#6532',
  check(ctx) {
    for (const [rel, variable, agent] of STEPS) {
      const gate = `Skip this step entirely if NOT \`$${variable}\`.`;
      ctx.doc(rel)
        .has(gate, `the step must skip itself unless $${variable} is set`)
        .before(gate, 'Agent(', `the $${variable} gate must come before the first ${agent} Agent() dispatch`);
    }
  },
};
