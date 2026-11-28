---
type: Added
pr: 6656
---
**The executor's worktree guards and plan commit ledger are now single commands** — `gsd_run query executor.guard` runs the spawn-time branch and base check and the pre-commit HEAD, protected-branch, worktree-root and path checks, verify-only, exiting 42 on any failed check; `gsd_run query executor.ledger record|read` keeps the plan's base under the worktree's own `.gsd/executor-ledger/` and measures the SUMMARY's `commits:` from it. The executor's guard and ledger steps and the `worktree_branch_check` block are now single `gsd_run` lines, and the planner's verify-command guidance asks for one command per `<automated>` step. (#6216)
