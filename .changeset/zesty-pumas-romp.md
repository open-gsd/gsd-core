---
type: Fixed
pr: 6081
---
**Human-recorded UAT results are no longer lost when execute-phase re-runs** — a phase that already had a filled UAT file had it reset to all-pending and committed when verification again needed human checks; new items are now appended and existing results kept. (#5845)
