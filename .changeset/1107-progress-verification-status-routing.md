---
type: Fixed
pr: 1116
---
**`/gsd-progress` no longer reports a phase as complete (and routes to the next phase) when its verification ended `human_needed` or `gaps_found`** — routing derived completeness from plan/summary counts only and never consulted the `verification.status` query (the seam built in #651). A new Step 1.7 consults it for the current phase, and the routing table sends `gaps_found` to `/gsd:plan-phase {phase} --gaps` (Route V.gaps) and `human_needed` to `/gsd:verify-work {phase}` (Route V.human) before the generic complete row. `passed`, `missing` (unverified), and `unknown` still route as complete, so unverified phases are not falsely blocked. (#1107)
