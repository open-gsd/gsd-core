---
type: Fixed
pr: 0
---
**The code-review disposition ledger no longer ignores fix-report findings under other section titles** — a fix report that titled its sections `## Fixed` and `## Skipped` (or anything but the two template titles) left every fixed finding `open` with no note. `## Fixed` and `## Skipped` now classify like `## Fixed Issues` and `## Skipped Issues`, and any finding heading left under a section the step does not recognise is named on the verdict line with its report file. (#6126)
