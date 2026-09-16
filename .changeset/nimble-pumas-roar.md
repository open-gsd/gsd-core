---
type: Fixed
pr: 4781
---
**phase-plan-index now exposes DAG-ready plans** — `ready_plans` (and per-plan `ready`/`unresolved_dependencies`) distinguish plans whose dependencies all have completion evidence from those merely unblocked by a halt; /gsd-execute-phase dispatches only ready plans and reports what it is waiting on instead of skipping incomplete predecessors. (#4628)
