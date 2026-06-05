---
type: Fixed
pr: 3117
---
**Worktree prune regression checks are now path-normalized** — pruning safety tests now parse `git worktree list --porcelain` and assert structured normalized paths, preventing path-separator false negatives across platforms while preserving non-destructive prune guarantees.