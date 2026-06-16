---
type: Fixed
pr: 1347
---
**Quick worktree execution now accepts parent-or-plan bases for pre-dispatch plan commits** — quick mode records the parent and plan commit around the pre-dispatch PLAN.md commit, lets the worktree guard accept either approved base, materializes the plan from git objects when a runtime forks from the parent, and teaches cleanup to validate the same allowed-base set. (#1265)
