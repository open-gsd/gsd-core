'use strict';

// The canonical membership list for dispatch isolation (#6027, ADR-4630
// Decision 4): every markdown file that records a decision with
// `gsd_run query dispatch-isolation … --force-isolation`. The lint
// (`scripts/lint-dispatch-identity-drift.cjs`) asserts the scan of
// `gsd-core/workflows/**` and `gsd-core/references/**` equals this list both
// ways, so a new producer must be added here on purpose and a deleted one
// must be removed. Never generate this list from the scan: that would pass a
// hand-written site by construction.
const PRODUCER_SITES = Object.freeze([
  'gsd-core/references/dispatch-isolation-gate.md',
  'gsd-core/workflows/diagnose-issues.md',
  'gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md',
  'gsd-core/workflows/execute-phase/steps/per-plan-worktree-gate.md',
  'gsd-core/workflows/execute-plan.md',
  'gsd-core/workflows/quick-batch/steps/worktree-dispatch.md',
  'gsd-core/workflows/quick.md',
]);

module.exports = { PRODUCER_SITES };
