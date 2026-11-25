---
type: Added
pr: 0
---
**Post-merge gate cadence for `/gsd-execute-phase`** — set `workflow.post_merge_gate` to `on_merge` to skip the post-merge build and test gate when `workflow.use_worktrees` is `false`, where a wave merges no worktree branch. A skipped gate prints a line naming the reason. The default, `always`, runs the gate after every wave as before, and `config-set` accepts only `always` or `on_merge`. (#5822)
