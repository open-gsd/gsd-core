---
type: Fixed
pr: 6365
---
**A subagent no longer gets the parent session's context warning as its own** — in Claude Code a subagent's hook input carries the parent's `session_id`, so the context monitor read the parent's usage and told the subagent `CONTEXT WARNING: Usage at N%` with the parent's N, and could spend the parent's debounce or start its CRITICAL `record-session` write. An input with `agent_id` now exits before touching any of the session's monitor files; top-level sessions, including `claude --agent`, are monitored as before. (#6360)
