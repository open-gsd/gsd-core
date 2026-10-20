---
type: Fixed
pr: 0
---
**Milestone-grouped roadmaps no longer inflate progress, rewind STATE, or reflow untouched sections** — `completed_phases`, `total_phases` and `percent` now count only the current milestone's Progress-table rows and stay stable across the next `state.*` write, re-running `phase.complete` on an already-complete phase leaves STATE and the Complete cell untouched, Markdown writes normalize only the lines they changed instead of re-spacing the whole document, and `ship` tracking writes the activity line with its description instead of a prose `Status`. (#5165)
