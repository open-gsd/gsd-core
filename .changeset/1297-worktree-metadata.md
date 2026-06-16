---
type: Fixed
pr: 1349
---

**Parallel worktree execution now has executor-authored cleanup metadata** — executor agents capture their worktree path, branch, and expected base before task commits and return a parseable metadata block for execute-phase to prefer over runtime harness metadata. (#1297)
