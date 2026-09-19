---
type: Fixed
pr: 4507
---
Capability predicate gates now receive the complete phase context available at each `gsd_run check predicate` dispatch — `execute:post`, `plan:post`, `execute:wave:post` and `verify:pre` — so supported phase placeholders no longer resolve empty. (#4483)
