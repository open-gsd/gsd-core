---
type: Fixed
pr: 5424
---
**`state planned-phase --plans` records the plan count on `Plan:` lines** — a STATE.md whose position held only `Plan: 0 TBD in current phase` reported success but left the `Plan:` line at `0 TBD in current phase` and `Status: Ready`. A bare `Status: Ready` now becomes `Ready to execute` on `planned-phase`, with or without `--plans`.
