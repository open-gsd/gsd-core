---
type: Added
pr: 0
---
**The executor's worktree guards and plan commit ledger are now single commands** — `gsd_run query executor.guard` runs the spawn-time branch and base check and the pre-commit HEAD, protected-branch, worktree-root and path checks, verify-only, exiting 42 on any failure; `gsd_run query executor.ledger record|read` keeps the plan's base under the worktree's own `.gsd/executor-ledger/` and measures the SUMMARY's `commits:` from it. The executor, the `worktree_branch_check` block and the planner's verify-command guidance now use one command per Bash call. (#6216)
