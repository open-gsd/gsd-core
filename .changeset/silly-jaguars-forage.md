---
type: Fixed
pr: 5631
---
**`/gsd-complete-milestone --ws` no longer rewrites or commits the shared `PROJECT.md`** — closing a workstream milestone skipped nothing before: the evolution review edited the project-wide file and the archive commit staged it. It now skips both, as `/gsd-new-milestone --ws` does, and the workflow no longer calls `PROJECT.md` workstream-scoped. (#5195)
