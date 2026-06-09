---
type: Fixed
pr: 913
---
**Top-level Claude Code `/gsd-plan-phase` now always spawns the researcher/planner/plan-checker agents instead of collapsing them inline** — a `<runtime_compatibility>` block after `</available_agent_types>` makes the Agent-availability requirement explicit and documents that the workflow fails-closed (stops with a clear log message) in genuinely Agent-less contexts; seven "ORCHESTRATOR RULE — CODEX RUNTIME" labels are renamed to "ALL RUNTIMES" so the guard applies universally; `execute-phase.md` scopes its existing "Other runtimes" inline-fallback prose to non-Claude contexts, preserving the #853 backgrounded-agent behaviour. (#913)
