---
type: Fixed
pr: 0
---
**Worktree cleanup-wave rescues SUMMARY artifacts from relative worktree paths** — a manifest entry carrying a relative `worktree_path` made the rescue walk the CLI's working directory instead of the repo root, finding nothing and blocking the entry `worktree_dirty` instead of rescuing; the rescue now resolves the path against the repo root, the same way every git consumer of the field already does. (#4758)
