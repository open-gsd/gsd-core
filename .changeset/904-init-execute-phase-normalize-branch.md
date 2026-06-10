---
type: Fixed
pr: 904
---
**`init execute-phase` and `cmdCommit` now produce correct `branch_name` when `project_code` is set** — the `{phase}` substitution in `phase_branch_template` now calls `normalizePhaseName()`, stripping the project-code prefix and zero-padding the number, so the generated branch is e.g. `gsd/phase-01-foundation` instead of `gsd/phase-CK-01-foundation`. Both the execute-phase output path (`src/init.cts`) and the pre-execution commit path (`src/commands.cts`) are fixed. (#904)
