---
type: Fixed
pr: 5424
---
**`/gsd-plan-phase` step 13b reads the plan count from `find-phase` and stops when that read fails** — it passed `${PLAN_COUNT}` to `state planned-phase --plans`, and nothing in the workflow set that variable.
