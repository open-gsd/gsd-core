---
type: Added
pr: 5595
---
**Pi now runs GSD's guard hooks** — on Pi the hook scripts never ran for tool calls, so the secret-file, write-shrink, worktree-path and prompt-injection guards were silent. The Pi extension now bridges `tool_call` and `tool_result` to them (a guard that blocks stops the call and the model sees the reason, advisories reach the model with the call result), and every other Claude hook has a recorded Pi disposition. (#5560)
