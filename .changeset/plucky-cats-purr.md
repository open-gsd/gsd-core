---
type: Fixed
pr: 579
---
Worktree executor agents no longer leak writes to the main checkout: a new PreToolUse hook (gsd-worktree-path-guard.js) hard-blocks Edit/Write/MultiEdit calls whose absolute path resolves outside the active worktree root.
