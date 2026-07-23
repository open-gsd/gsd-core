---
type: Fixed
pr: 0
---
**`use_worktrees: false` is now honored at the worktree dispatch gate** — the per-plan dispatch condition checks BOTH the project-level `USE_WORKTREES` flag AND the per-plan `USE_WORKTREES_FOR_PLAN` variable. Previously, the dispatch gate checked only the per-plan variable (derived from submodule intersection), so plans that didn't touch submodules would still fork `isolation="worktree"` agents even when the project-level setting disabled worktrees entirely. The fix is net-negative in file size (prose compression offsets the added shell condition). (#2474)
