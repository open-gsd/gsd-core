---
type: Fixed
pr: 5584
---
**`/gsd-health --repair` can now clear a legacy `pass_with_caveats` verification report, unblocking the other phases** — one report with a status outside the closed set made `phase complete` and `state begin-phase` refuse for every phase in the milestone, and W030 offered only lossy recoveries. W030 is now repairable for that known legacy value: the status becomes `passed` and the original is kept as `legacy_status`. Unknown statuses stay refused and unrepairable. (#5291)
