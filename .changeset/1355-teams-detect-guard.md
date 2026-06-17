---
type: Added
pr: 1371
---

**`gsd-tools query teams-status` + a plan-phase warning detect claude-code agent-teams** — GSD's multi-agent orchestration can stall under claude-code's experimental agent-teams (a subagent's completion can fail to route back to the orchestrator). A new read-only `query teams-status` command reports `{ active, runtime, env_present, source }` (and `--active` for a clean shell guard), and `/gsd:plan-phase` now emits a single non-fatal warning when agent-teams is detected, recommending you disable it for GSD workflows. The detector only activates on the `claude` runtime with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` strictly truthy — every other runtime and the teams-off path are completely unaffected. (#1355)
