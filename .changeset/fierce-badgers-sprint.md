---
type: Fixed
pr: 0
---
**A verification report with a status outside `passed | gaps_found | human_needed` is now a hard error, and a stale phase re-verifies instead of looping** — `status: verified` (or `Passed`, `stale`, a number) used to route as `unknown` to `/gsd-execute-phase`; every command that reads the report now stops with `verification_status_invalid` naming the file and the accepted values, and `/gsd-health` reports it as `W030`. A stale report has one route: `/gsd-verify-work` now runs the same regeneration step as `/gsd-execute-phase` so the phase ends `passed`, and a phase directory that does not exist reads `phase_dir_not_found` with no next command instead of sending you to re-execute it (#5118).
