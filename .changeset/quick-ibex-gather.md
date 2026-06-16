---
type: Fixed
pr: 1078
---
`state planned-phase` now advances the Status field when the prior phase left a `Complete ✓` (checkmark) or bare `Complete` terminal status. Previously such a status matched no known template default, so the transition was silently skipped and the state machine stayed stuck on the prior phase. Caveat-bearing statuses (e.g. `Complete but needs manual QA`) remain preserved. (#1070)
