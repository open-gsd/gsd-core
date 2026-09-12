---
type: Fixed
pr: 4612
---
worktree cleanup-wave no longer blocks an entry whose worktree directory the harness already removed: a confirmed-absent checkout is distinguished from a genuine branch mismatch, the branch merges, and teardown prunes the stale admin entry instead of failing. A present worktree on the wrong branch still blocks unchanged, and so does one that cannot be read — only a confirmed absence takes the new path, never a permission or I/O error.
