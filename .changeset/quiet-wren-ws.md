---
type: Fixed
pr: 6071
---
**A linked worktree of a `planning.sub_repos` workspace now resolves the workspace's `.planning/`** — inside such a worktree GSD fell back to the repository's main checkout and read and wrote the wrong planning store; it now resolves the workspace's `.planning/`. (#4908)
