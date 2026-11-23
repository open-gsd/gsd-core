'use strict';

// The progress workflow's MVP-mode display contract: it declares MVP_MODE, resolves it through the centralized
// phase.mvp-mode verb, sources user-flow status from PLAN.md task names with user-flow framing, and shows the
// standard display when the mode is not MVP. progress.md is fragmented (#2994) into progress/steps/*.md, so the
// host and every step file directly under that directory are read together. Also the folded #14 guard: --auto is
// documented in commands/gsd/progress.md, passed through in its <process> block, and handled in next.md.
// The test's fallback assertion was satisfied by two unrelated lines (a DISCUSS_MODE shell line and a forensic-audit
// sentence); the contract asks for the conditional section marker that makes the standard display the default.
// Was tests/progress-mvp-display.test.cjs.

const HOST = 'gsd-core/workflows/progress.md';
const STEPS_DIR = 'gsd-core/workflows/progress/steps';

const linesOf = (text) => text.toLowerCase().split('\n');

module.exports = {
  id: 'progress-mvp-display',
  issue: '#14',
  check(ctx) {
    // The step files directly under the directory (the test read it without descending), in sorted order.
    const steps = ctx.list(STEPS_DIR, '.md', 'the progress step files hold the MVP display').filter((rel) => rel.split('/').length === STEPS_DIR.split('/').length + 1);
    ctx.docs([HOST, ...steps])
      .has(/mvp_mode/i, 'the progress workflow must declare MVP_MODE')
      .has(/phase\.mvp-mode/i, 'the progress workflow must resolve MVP mode via the centralized phase.mvp-mode verb')
      .satisfies((text) => linesOf(text).some((line) => line.includes('plan.md') && line.includes('task')), 'MVP display must source user-flow status from PLAN.md tasks')
      .has(/user-flow|user-visible/i, 'MVP display must use user-flow framing');
    ctx.doc(HOST)
      .has('when="state:phase-mvp-mode"', 'the mvp-display section must be loaded only when the phase MVP mode is on, so any other mode gets the standard display');

    ctx.doc('commands/gsd/progress.md')
      .has('--auto', 'progress.md must document the --auto flag in the <flags> section')
      .slice('<process>', '</process>')
      .has('--auto', 'the progress.md <process> block must explicitly mention --auto so it is not silently stripped at the --next handoff');
    ctx.doc('gsd-core/workflows/next.md')
      .has('--auto', 'next.md must handle the --auto flag to chain step invocations automatically')
      .has('--next --auto', 'next.md must instruct re-invocation of /gsd:progress --next --auto after step completion to enable chaining');
  },
};
