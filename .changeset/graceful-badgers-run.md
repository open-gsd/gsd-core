---
type: Fixed
pr: 5416
---
**The executor no longer grants itself a `git reset --hard` exception at startup** — its list of commands prohibited inside a worktree exempted the `<worktree_branch_check>` step, which has been verify-only since #48: on a failed assertion it exits 42 and the orchestrator recovers. The prohibition is now unconditional, matching the branch-check fragment. The git-integration reference that execute-plan hands the executor as required reading no longer lists `git reset --hard` as a failure-recovery option either.
