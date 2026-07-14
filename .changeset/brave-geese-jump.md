---
type: Changed
pr: 0
---
**Phase-completion now writes `Status: All phases complete` instead of the overloaded bare `Milestone complete`** — the phase-level completion verb (`completePhaseCore`) was writing the same bare 'Milestone complete' string that the milestone-close verb uses for terminal state, causing a phase-level verb to own a milestone-level field. Per ADR-2207, phase-completion now writes the existing intermediate value 'All phases complete' (already used in gsd2-import.cts); milestone termination ('<version> milestone complete' / 'Awaiting next milestone') remains solely with the milestone-close verb. The Status lifecycle is now: Ready to plan → All phases complete → <version> milestone complete → Awaiting next milestone. (#2204)
