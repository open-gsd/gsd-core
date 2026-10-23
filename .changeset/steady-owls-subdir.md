---
type: Fixed
pr: 5653
---
**Running a committing command from a subdirectory of a linked worktree no longer commits into the main checkout** — the project root resolved to the main checkout whenever the current directory had no `.planning/` of its own, even when the worktree's own root did, so `commit` reported success while landing in the wrong repository. The worktree's own root now wins; a linked worktree with no `.planning/` anywhere still resolves to the main checkout. (#4885)
