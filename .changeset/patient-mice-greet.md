---
type: Fixed
pr: 1843
---
**`init milestone-op` now ignores backlog `999.x` headings when counting milestone phases** — parked backlog items no longer inflate `phase_count` or pin `all_phases_complete` false for an otherwise finished milestone. (#1843)
