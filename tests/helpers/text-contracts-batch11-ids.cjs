'use strict';

// The ids of the text contracts that batch 11 of ADR-6315 item 19 (#6583) added; tests/text-contracts.test.cjs pins the
// directory to its earlier list plus these, and tests/text-contracts.batch11.test.cjs exercises them.
module.exports = [
  'autonomous-ui-steps',
  'discuss-phase-power',
  'workflow-maintainer-skip',
  'update-workflow',
  'plan-phase-ui-redirect',
  'review-default-reviewers-workflow',
];
