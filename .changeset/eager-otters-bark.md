---
type: Added
pr: 6350
---
**Run a plan on another runtime** — a plan that declares `executor_runtime` is executed by that runtime's own CLI in a GSD-created worktree when `workflow.cross_runtime_execution` is on, and falls back to the host's dispatch with one reason whenever the target cannot run (#6303).
