---
type: Fixed
pr: 0
---
**The spec/ui zero-applicable guard now fires on the all-unclassified case** — probe coverage exposes an `unclassified` count beside `applicable`, and spec-phase/ui-phase warn when every requirement classifies to nothing instead of reporting a healthy non-zero total; `applicable` itself is count-preserving. (#4656)
