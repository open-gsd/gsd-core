---
type: Fixed
pr: 5979
---
**A named-pipe SUMMARY file no longer hangs phase commands** — a FIFO or endless-source SUMMARY in a phase directory made phase lookup, phase-plan-index and the execute-phase and plan-phase init commands block forever; SUMMARY status is now read through one non-blocking, regular-file-only, size-capped reader. (#5789)
