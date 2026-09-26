---
type: Fixed
pr: 4969
---
**`init` verbs no longer emit the directory slug as `phase_name`** — `init plan-phase`, `verify-work`, `code-review`, `discuss-phase-assumptions` and `phase-op` now prefer the ROADMAP's display name, as `init execute-phase` already did (#3171), so a replan no longer overwrites STATE.md `current_phase_name` with the slug. (#4854)
