---
type: Fixed
pr: 6265
---
**Quick-batch's orchestrator-worktree dispatch now gives every executor-prompt placeholder a value for a quick item** — it reused execute-phase's isolation prompt "verbatim" but named values for only three of the seven placeholders, so `{phase_number}`, `{phase_name}`, `{plan_id}` and `{plan_padded}` could reach the executor prompt and the worker-record summary path as literal text. A quick item now states `{plan_padded}` as its quick id, marks the three phase-only placeholders not applicable, uses `Execute quick item <id>.` as the header, and omits the dispatch marker line. (#5934)
