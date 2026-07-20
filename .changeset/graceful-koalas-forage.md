---
type: Fixed
pr: 0
---
**`/gsd-stats` no longer misreports a phase as Not Started when two directories collide on the same phase key** — `cmdStats` now folds colliding statuses by precedence (Complete > Needs Review > Executed > In Progress > Planned > Not Started) instead of overwriting last-write-wins, so the furthest-along status wins regardless of `fs.readdirSync` order. Separately, `/gsd-health` now emits a new W023 warning whenever two or more real phase directories collide on the same normalized phase key, naming both directories and their independently-computed statuses (neutral wording — never guesses which is the real one).
