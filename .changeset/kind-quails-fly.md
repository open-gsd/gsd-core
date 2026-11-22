---
type: Changed
pr: 6484
---
**`/gsd-plan-phase` now validates each `<automated>` command without running it** — a stated `<fails_when>` cannot reveal that a command does not parse, so a plan could pass every check and still ship commands that could not run (`Msg 8155`, a one-argument `CONCAT()`). Where a validate-only mode exists (`bash -n`, `node --check`, `ast.parse`, `SET PARSEONLY ON`, `cargo metadata --no-deps`), the planner runs it and records `[VALIDATED: …]` or `[UNVALIDATABLE: <reason>]` in the task's `<verify>`; plan-checker check 8g warns on a command with no record. Forms that look like validators but execute or write (`py_compile`, `cargo check`, `npm run --dry-run`, `terraform validate`) are named and banned. (#4586)
