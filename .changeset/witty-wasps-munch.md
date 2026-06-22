---
type: Added
pr: 1595
---
**`/gsd-plan-phase` now flags a stale codebase map before planning** — the `drift` capability runs its codebase-drift check at `plan:pre` (non-blocking, warn-only), so a stale STRUCTURE.md is surfaced before the planner is spawned instead of being discovered mid-execution by the existing `execute:wave:post` gate. Gated on a new `workflow.plan_drift_precheck` toggle (default on), independent of `workflow.schema_drift_gate`, so autonomous/CI runs can silence the plan-time advisory without disabling the execute-time gates.
