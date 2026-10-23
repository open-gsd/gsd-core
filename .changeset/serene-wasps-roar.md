---
type: Fixed
pr: 5549
---
**`roadmap update-plan-progress` no longer ticks a plan row in a shipped milestone or another phase** — a completed plan's checkbox was ticked at its first match anywhere in ROADMAP.md, so an archived `<details>` milestone or a sibling phase sharing the plan id got the tick instead of the active phase. Rows are now ticked only inside the updated phase's own section and checklist entry (both, when the row is in each) within the active milestone, the same scoping `phase complete` uses, a `<details>` block after the active milestone no longer stops ticking (nor the Progress-table, Plans-count and completion-checkbox writes), and a phase listed in both the milestone and its `(Phase Details)` window gets its rows inserted and ticked once. Like `phase complete`, rows under a `####` sub-heading inside the phase section, and `-[ ]` lines without a space after the dash, are not ticked; the roadmap template keeps plan rows directly under `Plans:`. (#5483)
