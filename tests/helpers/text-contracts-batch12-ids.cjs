'use strict';

// The ids of the text contracts that batch 12 of ADR-6315 item 19 (#6654) added; tests/text-contracts.test.cjs pins the
// directory to its earlier list plus these, and tests/text-contracts.batch12.test.cjs exercises them.
module.exports = [
  'adr-230-pr-target-policy',
  'code-review-summary-parser',
  'audit-fix-command',
  'progress-forensic',
  'edit-phase',
  'adr-218-release-version-validation',
  'mcp-tool-inheritance',
  'tdd-single-statement',
  'agent-classification-parity',
  'parallel-dependent-plans',
  'explore-command',
  'plan-checker-coupling',
  'edge-probe-spec-phase-contract',
];
