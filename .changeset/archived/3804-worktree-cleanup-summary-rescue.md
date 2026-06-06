---
type: Fixed
pr: 3804
---
**`worktree.cleanup-wave` no longer blocks on executor's uncommitted SUMMARY.md** — `executeWorktreeWaveCleanupPlan` previously returned `cleanup_blocked` / `worktree_dirty` when the executor left `<quick_id>-SUMMARY.md` uncommitted in the worktree's `.planning/` directory (the documented contract — the orchestrator commits it). The fix ports the shell-fallback rescue logic from `quick.md` into the CJS function: before the dirty-state check, all `*SUMMARY.md` files under `<worktree>/.planning/` are copied to the main tree (if absent or divergent), then filtered out of the porcelain output. Only non-SUMMARY dirty files now block cleanup. (#3804, mirrors #2296/#2070/#2838)
