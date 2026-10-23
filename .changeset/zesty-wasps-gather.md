---
type: Fixed
pr: 5580
---
**`/gsd-quick` worktree base check accepts a fork from the plan commit's parent when the planner already committed the plan** — the alternate base was captured before the pre-dispatch commit attempt, so it equalled the plan commit and was substituted empty; a worktree forked from the plan commit's parent then failed `worktree_branch_check` with exit 42. It now records the plan commit's immediate parent in both orderings (and stays empty when docs commits are off). (#5209)
