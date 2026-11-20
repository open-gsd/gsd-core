---
type: Fixed
pr: 0
---
**Codex update no longer aborts on current agent settings or moves nested feature settings** — a bare `[agents]` table holding `enabled`, `max_concurrent_threads_per_session`, `default_subagent_model` or `default_subagent_reasoning_effort` now passes the post-write schema check and is kept through an install, and dotted assignments such as `multi_agent_v2.<key> = …` under `[features]` stay in `[features]` instead of being relocated into the table above it. (#6165)
