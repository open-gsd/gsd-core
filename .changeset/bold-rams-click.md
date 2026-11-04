---
type: Fixed
pr: 0
---
**Catch-up merges no longer pull the base branch into a phase's evaluation scope** — a merge commit listed as a task commit reported every file the base branch changed as the phase's own work, so review, UI safety, schema drift and decision-coverage gates evaluated the wrong files; a merge now contributes only its conflict resolutions and edits, the base branch's files no longer show up as unlisted phase work, and a SUMMARY that lists only merge commits degrades to the phase range instead of reporting the merge's edits as the whole phase. (#5751)
