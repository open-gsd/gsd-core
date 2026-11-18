---
type: Fixed
pr: 0
---
**`/gsd:code-review --fix` run from a linked worktree no longer merges the fixes into the main checkout's branch** — the fixer fast-forwarded the first `git worktree list` entry (the main checkout, usually `main`) instead of the worktree that has the reviewed branch checked out, so the fixes landed on the wrong branch or were stranded on the temp branch with a warning that named the wrong one. (#5876)
