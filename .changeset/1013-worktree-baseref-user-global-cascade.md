---
type: Fixed
pr: 0
---
**`worktree base-check` now honors a user/global `worktree.baseRef:"head"` (and `CLAUDE_CONFIG_DIR`)** — base-check resolved `baseRef` from the project checkout's `.claude/` only, so a machine-wide `head` set via `/config` (the layer the harness itself honors) was invisible. On any phase/feature lane it returned `shouldDegrade:true` and `execute-phase` silently forced sequential execution, losing the parallel worktree execution the user configured. Resolution now falls back to the user/global `settings.json` (via `getGlobalConfigDir('claude')`, honoring `CLAUDE_CONFIG_DIR`) below the existing project-local and project-shared layers. (#1013)
