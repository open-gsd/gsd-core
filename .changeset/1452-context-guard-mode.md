---
type: Added
pr: 1452
---
**`workflow.context_guard_mode` config key** — proactive context-exhaustion guard for `execute-phase`. Before each wave, the orchestrator self-assesses context pressure using the degradation signals defined in `context-budget.md`. Values: `warn` (default — emit warning and recommend `/gsd:pause-work` when POOR tier detected), `auto` (automatically invoke `/gsd:pause-work` before next wave), `off` (disable). Set via `gsd config-set workflow.context_guard_mode auto` for fully autonomous checkpoint behaviour. (#1452)
