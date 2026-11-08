---
type: Fixed
pr: 0
---
**Capability `plan:pre` steps and gates now run when planning a phase** — a `plan:pre` step that runs a command, a skill step outside auto-chain mode (such as mempalace recall), and any gate other than the built-in UI and drift checks were listed by `loop render-hooks plan:pre` and then silently skipped, so a capability's blocking gate could not stop planning. Plan-phase now dispatches every active `plan:pre` step and evaluates every active gate before the planner starts, in manual and auto-chain mode. (#5982)
