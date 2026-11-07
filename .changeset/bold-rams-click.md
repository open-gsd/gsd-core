---
type: Fixed
pr: 5973
---
**Catch-up merges no longer pull the base branch into a phase's evaluation scope** — a merge commit listed as a task commit reported every file the base branch changed as the phase's own work, so review, UI safety, schema drift and decision-coverage gates evaluated the wrong files; a merge now contributes only its conflict resolutions and edits, the base branch's files no longer show up as unlisted phase work, and unlisted phase work (including on a sub-branch merged in, or an edit to a file the base also touched) stays named in the outside-the-union list, and a SUMMARY whose every listed commit is a merge degrades to the phase range instead of reporting the merge's edits as the whole phase. (#5751)
