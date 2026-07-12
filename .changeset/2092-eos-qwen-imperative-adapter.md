---
type: Changed
pr: 2153
---
**Qwen Code now projects GSD's specialist agents as native subagents** — installing GSD into Qwen Code writes `~/.qwen/agents/gsd-*.md` files you can invoke directly (planner, executor, code-reviewer, …) instead of reaching them only through skill prose, and a `SubagentStart` hook now fires alongside `SubagentStop`. Qwen's install is driven by its negotiated capability descriptor instead of hardcoded runtime special-cases. (#2092)
