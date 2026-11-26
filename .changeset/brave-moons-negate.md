---
type: Fixed
pr: 6703
---
**A "Depends on" line that starts with Nothing/None no longer blocks the phase with the phases it names in passing** — `init manager` mined the whole field for `Phase N` references, so `Nothing (independent of Phases 1 and 3)` reported the phase as blocked by phases 1 and 3; a leading `Nothing`/`None` now resolves to no dependencies under both the numeric and bracket conventions, and the roadmapper, add-phase and edit-phase guidance states the machine-read rule where the line is written. (#6507)
