---
type: Fixed
pr: 6189
---
**`roadmap update-plan-progress` now merges missing plan rows into the plan list in plan order** — a missing row is placed by plan id (`12-10` after `12-9`) instead of stacked above every existing row, a loose list keeps its blank line, and the `TBD (run ... to break down)` stub that `phase add` and `phase insert` write is dropped once real rows exist, whatever command form the runtime wrote into it. (#6171)
