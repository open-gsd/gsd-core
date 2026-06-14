---
type: Added
pr: 1242
---
**`gsd-tools drift-guard` — deterministic plan-drift severity/authority decisions (ADR-22).** The plan-review source-grounding pass now classifies cited-symbol drift through a tested seam (5-rung authority ladder, `grep`→`intel` auto-upgrade, severity mapping, rung≥3 hard-block) instead of re-deriving the rules from workflow prose on each run. (#1190)
<!-- docs-exempt: internal gsd-tools seam invoked by the plan-review-convergence workflow; no user-facing command/flag surface (deferred rungs documented in ADR-22) -->

