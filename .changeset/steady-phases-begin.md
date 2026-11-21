---
type: Fixed
pr: 6469
---
**execute-phase records phase start in STATE.md** — the begin-phase block passed `--phase`, `--name` and `--plans` variables that no step set for it (each workflow fence is its own shell), so `state begin-phase` exited with `Invalid --plans value` and STATE.md never recorded the active phase; the block now assigns the phase number placeholder, reads the curated name from `roadmap.get-phase` and the plan count from `find-phase` (both workstream-scoped), and stops when the plan count cannot be read. (#6258)
