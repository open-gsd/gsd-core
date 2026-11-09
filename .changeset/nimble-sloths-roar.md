---
type: Fixed
pr: 5975
---
**`init --validate` now warns on a plan-count mismatch for `Plan: N of M` and `Current Plan: N of M`** — STATE.md written in the compound or hybrid shape recorded its plan total only in the position line, so `init execute-phase` and `init plan-phase` reported `state_warnings: []` even when the disk plan count disagreed. (#5786)
