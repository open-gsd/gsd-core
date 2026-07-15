---
type: Fixed
pr: 2309
---
**Hermes installs now project named-agent dispatch onto `delegate_task` instead of asserting a nonexistent `Agent` tool** — installed Hermes workflows brand-swapped "Claude Code"→"Hermes Agent" but kept literal `Agent(...)` calls and falsely claimed "The Agent tool IS available", which Hermes doesn't expose. A Hermes `.md` converter now rewrites named dispatch onto Hermes's `delegate_task` contract (embedding the resolved role prompt since Hermes has no named-agent lookup, mapping background dispatch, dropping unsupported per-call model), driven by the runtime's documented dispatch facts, and fails closed if a referenced role prompt is missing. (#2284)
