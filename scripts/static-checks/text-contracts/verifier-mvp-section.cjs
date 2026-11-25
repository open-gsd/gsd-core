'use strict';

// The gsd-verifier agent defines an MVP Mode Verification section that emphasises user-visible outcomes, references
// verify-mvp-mode.md (which exists) and keeps its goal-backward terminology. Was tests/verifier-mvp-section.test.cjs.

module.exports = {
  id: 'verifier-mvp-section',
  check(ctx) {
    ctx.doc('agents/gsd-verifier.md')
      .has(/mvp[ -]mode verification/i, 'the agent must define an MVP Mode Verification section')
      .has(/verify-mvp-mode\.md/i, 'the agent must reference verify-mvp-mode.md')
      .has(/goal-backward/i, 'the agent must preserve goal-backward terminology');
    ctx.exists('gsd-core/references/verify-mvp-mode.md', 'the referenced verify-mvp-mode.md must exist');
  },
};
