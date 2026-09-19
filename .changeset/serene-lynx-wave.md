---
type: Fixed
pr: 4609
---
**`/gsd-pr-branch` no longer aborts on a "third bucket" chain conflict** — when a later included commit reuses a `.planning/` path that an earlier excluded commit also touched, `create_pr_branch`'s cherry-pick loop now resolves the conflict with `git checkout --theirs` instead of halting and rolling back the whole run.

The resolution reads the conflicted-path list one path per line, so a `.planning/` path containing a space resolves correctly instead of being word-split into fragments that match nothing.

Auto-resolution only fires when the base branch has not itself changed the path since the feature branch diverged; if it has, the run halts as before rather than overwriting the base branch's own content.
