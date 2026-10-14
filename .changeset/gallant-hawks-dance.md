---
type: Fixed
pr: 53
---
**`state planned-phase`** — records the `--plans` count on STATE.md documents that use the `Plan:` / `Current Plan:` Current Position line, keeps replan progress, and now exits non-zero (writing nothing) when no such line or `Total Plans in Phase:` exists. Fixes #5320.
