---
type: Fixed
pr: 0
---
**`phase add`, `phase add-batch` and `phase insert` refuse a STATE milestone with no ROADMAP heading** — when STATE.md named a milestone (such as v9.9) that ROADMAP.md has no heading for, these verbs numbered the new phase and wrote its `Depends on` line against every unshipped milestone and reported success; they now stop before writing anything and name the milestone that failed to resolve. (#5726)
