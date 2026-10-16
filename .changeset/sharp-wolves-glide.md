---
type: Fixed
pr: 5445
---
A sequential executor running in a linked phase worktree can commit on its configured phase branch again, instead of being refused by the per-agent branch allow-list after finishing its work. The allow-list now applies unless the executor's own dispatch prompt carries a sequential_execution block; protected-branch and detached-HEAD refusals are unchanged (#4799).
