---
type: Fixed
pr: 5489
---
Agent prompts, workflows and references now scope their raw `git commit` with a `--` pathspec, so files staged by another session no longer land in task commits; a guard test fails on any unscoped `git commit` in `agents/*.md`, `gsd-core/workflows/` and `gsd-core/references/` (#5211).
