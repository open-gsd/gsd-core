---
type: Fixed
pr: 0
---
**The orphan worktree reaper finds the directories git has forgotten** — `worktree.reap-orphans` listed candidates only from `.git/worktrees/`, so the residue a failed harness teardown leaves (an `agent-a<hex>` directory under `.claude/worktrees/` with no `.git` file and no admin entry, a full `node_modules` inside) was invisible and the verb reported `ok: true, reaped: 0`; a second pass now removes such a directory only on the positive evidence ADR-5812 requires (a harness name and branch, unregistered, no tracked file or nested repository, nothing recent, nothing git lacks, no ignored secret or user-data file the harness did not copy) by renaming it to a reserved name and deleting it without following links, and the verb output carries `scan` so `reaped: 0` from a pass that did not look is no longer an all-clear. (#4941)
