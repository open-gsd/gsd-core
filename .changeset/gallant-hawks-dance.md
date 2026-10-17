---
type: Fixed
pr: 5424
---
**`state planned-phase`** — records the `--plans` count on STATE.md documents that use the `Plan:` / `Current Plan:` Current Position line, keeps replan progress, and now exits non-zero (writing nothing) when no such line or `Total Plans in Phase:` exists. `--plans` is now validated as a non-negative integer, so `state begin-phase --plans` rejects non-integers too (it used to truncate `3.5` to 3). Fixes #5320.
