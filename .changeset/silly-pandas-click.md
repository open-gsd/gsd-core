---
type: Fixed
pr: 5010
---
**A ROADMAP Progress-table Status cell is now read by its leading status word**, so a cell like `Complete — shipped with gate results recorded` or `In Progress — gap closure 1/2` counts as complete or in progress in `.planning/state.json`, `state json`'s `completed_phases` / `percent`, and `/gsd` routing, instead of reading as pending. A cell that does not start with a status word is still pending. (#4967)
