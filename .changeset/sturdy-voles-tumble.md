---
type: Fixed
pr: 2250
---
**ROADMAP phase edits can no longer escape their section** — completing a phase updated its plan count and per-plan checkboxes with whole-document regexes that could bleed into a neighbouring phase; those per-phase writes are now structurally bounded to the phase own section via a new `withSection` / `withPhaseSection` seam (#2130, #2067, #2080). (#2250)
