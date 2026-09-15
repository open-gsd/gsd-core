---
type: Fixed
pr: 4778
---
**Codex orchestrator-worktree workers now persist a durable lifecycle record** — external executors dispatched by /gsd-execute-phase record their launch and terminal state (worktree worker-record/worker-status/worker-complete), so a resumed session reconciles finished or blocked workers from persisted state instead of manual PID discovery, and never re-dispatches a recorded plan. (#4624)
