---
type: Fixed
pr: 5424
---
**`/gsd-execute-phase` passes the `plan_count` and `phase_name` of its init JSON to `state begin-phase`** — it passed `${PHASE_NUMBER}`, `${PLAN_COUNT}` and `${PHASE_NAME}`, which no step of that shell block set, so phase start recorded no phase number, no plan count and no phase name. The block now re-reads the name from `init.execute-phase`; a phase with no name still records none, and a failed name read stops the block before `state begin-phase` runs.
