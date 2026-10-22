---
type: Fixed
pr: 5424
---
**`state planned-phase`** — records the `--plans` count on STATE.md documents that use the `Plan:` / `Current Plan:` Current Position line, keeps replan progress, and now exits non-zero (writing nothing) when no such line or `Total Plans in Phase:` exists. **Behaviour change:** `--plans` is now validated as a non-negative integer, so `state begin-phase --plans 3.5` now exits 1 (it used to truncate to 3). A same-phase replan is refused when `--plans` is below the executed count (the recorded `Plan: N of M` position minus one). Fixes #5320.
