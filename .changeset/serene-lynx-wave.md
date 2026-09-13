---
type: Fixed
pr: 4609
---
**`/gsd-pr-branch` no longer aborts on a "third bucket" chain conflict** — when a later included commit reuses a `.planning/` path that an earlier excluded commit also touched, `create_pr_branch`'s cherry-pick loop now resolves the conflict with `git checkout --theirs` instead of halting and rolling back the whole run.
