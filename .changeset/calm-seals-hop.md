---
type: Fixed
pr: 6082
---
**Capability hooks registered at `execute:pre` now run** — `/gsd-execute-phase` declared the `execute:pre` Loop Extension Point but never dispatched it, so a step, contribution or blocking gate installed there was silently skipped; the host now renders and dispatches it once before the first wave (a blocking gate stops execution before any plan runs), and the loop-host contract build now fails when a workflow declares a point it never renders. (#5848)
