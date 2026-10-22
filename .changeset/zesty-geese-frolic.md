---
type: Fixed
pr: 5490
---
**Completed phases are now recorded complete in ROADMAP.md, and `/gsd:ship` refuses one that is not** — a backlog `</details>` after the active milestone no longer hides it from the roadmap writers, `update-plan-progress` and `phase complete` write Status/Completed to the phase table instead of an earlier versions table, the executor flows stop when `update-plan-progress` declines (`missing_phase_details`), and ship blocks a phase whose checklist entry or progress-table row does not read complete or that has no such record; `phase add`/`add-batch`/`insert` now write that record (a checklist entry, else a progress-table row) so a tool-created phase, including a `phase_naming: custom` id, can ship (#5221).
