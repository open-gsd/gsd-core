---
type: Fixed
pr: 5651
---
**`check predicate` gate dispatches now pass every phase value their workflow already holds** — the `execute:post` dispatch omitted `--phase-dir` and the `plan-phase` dispatch omitted `--phase-number`, so a capability `command-exit-zero` gate referencing `${PHASE_DIR}` or `${PHASE_NUMBER}` there silently got an empty string. (#4483)
