---
type: Fixed
pr: 5424
---
**`/gsd-execute-phase` passes the `plan_count` and `phase_name` of its init JSON to `state begin-phase`** — it passed `${PLAN_COUNT}` and `${PHASE_NAME}`, which nothing in the workflow set, so phase start recorded no plan count and no phase name.
