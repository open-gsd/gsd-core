'use strict';

// The handoff/resume system enforces critical anti-patterns structurally (#1491): pause-work.md's anti-patterns
// template carries a Severity column with the values `blocking` and `advisory` and says a blocking anti-pattern
// triggers an understanding check at resume; discuss-phase.md and execute-phase.md check .continue-here.md for
// blocking anti-patterns, require a demonstration of understanding, ask the three questions (What is this
// anti-pattern? How did it manifest? What structural mechanism prevents it?) and say the check is mandatory. Was
// tests/anti-pattern-enforcement.test.cjs. The test accepted any of several words for most of these (`understanding`
// alone, `manifest` alone, `prevention` alone, `mandatory` in any case, `resume` instead of `understanding check`);
// the contract asks for the phrase the files carry so an unrelated word cannot satisfy it.

const RESUME_WORKFLOWS = [
  ['gsd-core/workflows/discuss-phase.md', 'discuss-phase.md'],
  ['gsd-core/workflows/execute-phase.md', 'execute-phase.md'],
];

module.exports = {
  id: 'anti-pattern-enforcement',
  issue: '#1491',
  check(ctx) {
    ctx.doc('gsd-core/workflows/pause-work.md')
      .has(/Severity|severity/, 'the template must include a Severity column in the anti-patterns table')
      .has('blocking', 'pause-work.md must document "blocking" as a valid severity value')
      .has('advisory', 'pause-work.md must document "advisory" as a valid severity value')
      .has('understanding check', 'pause-work.md must explain that blocking anti-patterns trigger an understanding check at resume');

    for (const [rel, name] of RESUME_WORKFLOWS) {
      ctx.doc(rel)
        .has('.continue-here.md', `${name} must check .continue-here.md before proceeding`)
        .has('blocking', `${name} must check for blocking anti-patterns`)
        .has('demonstrate understanding', `${name} must include a mandatory understanding verification step for blocking anti-patterns`)
        .has('What is this anti-pattern', `${name} must ask "What is this anti-pattern?"`)
        .has('How did it manifest', `${name} must ask "How did it manifest?"`)
        .has('structural mechanism', `${name} must ask "What structural mechanism prevents it?"`)
        .has('MANDATORY', `${name} must indicate that the blocking anti-pattern understanding check cannot be skipped (MANDATORY)`);
    }
  },
};
