---
type: Added
pr: 0
---
**Post-merge gate cadence for `/gsd-execute-phase`** — set `workflow.post_merge_gate` to `on_merge` to skip the post-merge build and test gate when `workflow.use_worktrees` is `false`, where a wave merges no worktree branch, and `HEAD` is not a merge commit. A skipped gate prints a line naming the reason. The default, `always`, runs the gate as before, and `config-set` rejects a misspelt value such as `on-merge`. (#5822)
