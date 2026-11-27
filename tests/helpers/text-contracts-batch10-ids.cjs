'use strict';

// The ids of the text contracts that batch 10 of ADR-6315 item 19 (#6577) added; tests/text-contracts.test.cjs pins the
// directory to its earlier list plus these, and tests/text-contracts.batch10.test.cjs exercises them.
module.exports = [
  'next-safety-gates',
  'contributor-standards',
  'release-backmerge-invariants',
  'cursor-reviewer',
  'ask-user-questions-fallback',
  'next-up-clear-order',
  'agent-skills-bootstrap',
  'spike-manifest-scoping',
  'seed-scan-new-milestone',
  'agent-required-reading-consistency',
  'planner-decomposition',
  'mempalace-capture-gate-default',
  'verifier-coincidental-reliance',
  'execute-phase-step-5-5-deviation-doc',
  'ultraplan-phase',
  'verify-mvp-uat',
  'workflow-jq-dependency',
  'verification-overrides',
  'mempalace-capture-headless-invocation',
  'no-hardcoded-home-gsd-tools',
  'thinking-model-guidance',
  'quick-commit-boundary-context-research',
  'spec-phase-probe-reachability',
  'post-merge-gate-watch-mode',
  'execute-phase-worktree-artifacts',
  'tdd-backend-wiring',
  'cleanup-branch-pruning',
  'code-review-flags',
];
