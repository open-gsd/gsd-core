'use strict';

// Playwright-MCP UI verification: the automated-ui-verification step (extracted from verify-work.md by
// #2994), ui-review.md and the ui-auditor agent mention Playwright, and automated verification is
// conditional with a manual fallback. Was tests/playwright-ui-verify.test.cjs.
//
// Tightened to what the files say: the original accepted `playwright` OR an unrelated phrase ("automated"
// AND "UI" in the step file; "screenshot" or "automated" in the agent), which its own comment calls vacuous
// for the step file. All three real files carry "playwright", so that is what the contract requires.

module.exports = {
  id: 'playwright-ui-verify',
  issue: '#2994',
  check(ctx) {
    ctx.doc('gsd-core/workflows/verify-work/steps/automated-ui-verification.md')
      .has(/playwright/i, 'the automated UI verification step should mention Playwright')
      .has(/if available|when available|if Playwright|fall back/, 'Playwright integration must be conditional with manual fallback');

    ctx.doc('gsd-core/workflows/ui-review.md')
      .has(/playwright/i, 'ui-review.md should reference Playwright-MCP');

    ctx.doc('agents/gsd-ui-auditor.md')
      .has(/playwright/i, 'gsd-ui-auditor.md should mention automated screenshot verification through Playwright');
  },
};
