---
type: Fixed
pr: 0
---

**`/gsd:pr-branch` now handles sub-repos defined in config** — when `planning.sub_repos` is set, the command scans each sub-repo for uncommitted changes and offers to create a branch, commit, push, and open a companion PR per sub-repo. Previously, sub-repos were silently ignored because all git commands ran against the shell's current directory instead of the intended repo path. All sub-repo git operations now use `git -C <repo>` so no shell-state assumptions are made.
