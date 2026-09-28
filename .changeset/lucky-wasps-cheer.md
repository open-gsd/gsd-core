---
type: Fixed
pr: 5077
---
**`/gsd-progress`, `/gsd-stats`, `init plan-phase`, `roadmap analyze` and `state.json` now agree on what state a phase is in** — a phase whose verification report says `passed` but no longer matches the code showed *Complete* in progress and stats while `/gsd-health` said it was not; it now shows *Executed* everywhere. `roadmap analyze` reports `executed` (not `partial`) for a fully executed, unverified phase, as `init manager` already did, and gives table-declared phases a real status instead of `ok`. A ROADMAP Progress Status cell with notes after the word (`Complete — shipped`) is read by that word, a `Planned` cell reads as `in_progress` in `state.json`, and `drift-guard phase-status` can now compare both. The milestone's completed-phase count (`init milestone-op`) counts only verified phases, not any phase with a summary. (#5060)
