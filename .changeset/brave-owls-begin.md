---
type: Fixed
pr: 5424
---
**`/gsd-execute-phase` passes the `plan_count` of its init JSON to `state begin-phase --plans`** — it passed `${PLAN_COUNT}`, which nothing in the workflow set, so the empty `--plans ""` now fails with `Invalid --plans value`.
