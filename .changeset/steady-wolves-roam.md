---
type: Fixed
pr: 5350
---
**Smart-entry no longer prints a phase's number as its position when a milestone continues earlier numbering (#5228)** — a milestone with phases 9-17 read "Phase 9 of 9 — needs a plan" instead of "Phase 1 of 9", and without a ROADMAP Progress table it was classified complete as soon as the phase number reached the phase count. The ordinal now comes from the phase's position in the milestone's phase list, and the legacy completion check compares against the milestone's last phase.
