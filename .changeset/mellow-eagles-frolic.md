---
type: Fixed
pr: 5363
---
`init plan-phase`, `verify-work`, `code-review`, `discuss-phase-assumptions` and `phase-op` now emit the ROADMAP display name as `phase_name` instead of the directory slug, so a replan no longer rewrites STATE.md's `current_phase_name` to a slug (#4854)
