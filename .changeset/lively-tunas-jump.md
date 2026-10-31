---
type: Fixed
pr: 5827
---
**A planner stall interval or threshold of `0` no longer breaks plan-phase's stall watch** — a hand-set `0` used to make every check a zero-length wait (interval) or flag a healthy planner as stalled on the first check (threshold); it now falls back to the default, and the inline-plan-threshold docs now show the real default of 2. (#3923)
