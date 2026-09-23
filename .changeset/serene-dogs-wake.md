---
type: Fixed
pr: 4612
---
worktree cleanup-wave no longer blocks an entry whose worktree directory the harness already removed: the branch merges and teardown prunes the stale admin entry instead of failing. Identity still comes from git's own worktree registration, so a path registered to a different branch blocks exactly as before, and removal must be confirmed by an ENOENT — a worktree that merely cannot be read blocks rather than being treated as removed. Every entry in a wave is evaluated against the registration as it stood before any teardown pruned it, so one removed worktree no longer strands the rest.
