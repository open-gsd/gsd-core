---
type: Fixed
pr: 5424
---
**`/gsd-plan-phase` step 13b reads the plan count from `find-phase` and stops when that read fails** — it used to pass the `PLAN_COUNT` set earlier in the run to `state planned-phase --plans`.
