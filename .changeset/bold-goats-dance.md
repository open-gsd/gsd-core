---
type: Fixed
pr: 6189
---
**`roadmap update-plan-progress` now merges missing plan rows into the plan list in plan order** — a missing row is placed by plan id (`12-10` after `12-9`, `12-01A` after `12-01`, `12-01.5` before `12-02`) instead of stacked above every existing row, a list keeps its blank lines and line endings, and the `TBD (run ... to break down)` stub that `phase add` and `phase insert` write is dropped as soon as the list holds a real row, whether or not a row was missing. A row counts as real by the presence test (a `-` checkbox naming one of the phase's PLAN files); a list with no real row takes the missing rows at the stub's position, else directly under `Plans:`. The stub text now has one owner in `core-utils` used by the writers and the matcher. (#6171)
