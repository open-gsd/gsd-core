---
type: Fixed
pr: 4951
---
Permit sequential execution to commit on configured non-protected phase branches when running inside a linked git worktree. Previously, `agents/gsd-executor.md` Step 0 pre-commit assertion and `execute-plan.md` state persistence conditioned their agent allow-list solely on `if [ -f .git ]; then`, halting sequential runs inside a developer's linked phase worktree with a false positive error. Step 0 and `execute-plan.md` now check the negotiated isolation mode (`ISOLATION`), permitting non-agent branches during sequential runs while continuing to enforce the `agent-*` / `worktree-agent-*` / `worktree-wf_*` namespace under `harness-worktree` and `orchestrator-worktree` isolation.
