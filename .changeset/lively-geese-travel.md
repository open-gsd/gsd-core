---
type: Added
pr: 0
---
**Plan-review convergence can run unattended** — `/gsd-plan-review-convergence --on-escalation exit` ends a non-converged run with a `CONVERGENCE_STATUS` line (`converged`, `open_conflicts`, `stalled`, `max_cycles`) instead of asking, and `/gsd-review --cycle-summary` returns the `CYCLE_SUMMARY` counters on its own, so a caller with no person attached no longer re-implements the counting rules. (#4617)
