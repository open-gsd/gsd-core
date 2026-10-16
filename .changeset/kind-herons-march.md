---
type: Fixed
pr: 5481
---
**The agent_skills self-load no longer re-reads the agent's own persona or silently does nothing** — agents now state their own type, the bootstrap supplies the launcher, and the self-load queries with `--skills-only`, so non-Claude runtimes get configured skills only.
