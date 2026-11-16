---
type: Fixed
pr: 5424
---
**`/gsd-execute-phase` reads the plan count from `find-phase` before `state begin-phase --plans`** — it passed `${PLAN_COUNT}`, which nothing in the workflow set, so the empty `--plans ""` now fails with `Invalid --plans value`.
