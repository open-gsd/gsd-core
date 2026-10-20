---
type: Fixed
pr: 5571
---
**Milestone-grouped roadmaps no longer inflate progress, rewind STATE, or reflow untouched sections** — `completed_phases`, `total_phases` and `percent` now count only the current milestone's Progress-table rows and stay stable across the next `state.*` write, re-running `phase.complete` on an already-complete phase leaves STATE and the Complete cell untouched, every Markdown write now normalizes only the lines it changed instead of re-spacing the whole document (a rewrite of more than 400 lines, or of a file over 2 MiB, is still normalized whole), and `ship` tracking writes the activity line with its description instead of a prose `Status`. (#5165)
