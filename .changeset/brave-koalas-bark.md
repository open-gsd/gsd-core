---
type: Fixed
pr: 5462
---
`/gsd-quick` under worktree isolation now tells the executor to write its SUMMARY at a worktree-relative path instead of an absolute main-checkout path that `gsd-worktree-path-guard` blocks, and to stop and report a guard denial rather than copy around it (#5085)
