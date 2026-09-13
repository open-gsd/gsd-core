---
type: Added
pr: 0
---

**A `model_overrides` entry may now be a runtime-keyed object, so one shared config can route an agent per runtime** — `"gsd-planner": { "codex": "gpt-6-astra", "claude": "opus" }` alongside the existing flat `"gsd-planner": "gpt-6-astra"`, which is unchanged and still applies everywhere. On a machine running two runtimes against one committed `.planning/config.json`, a flat per-agent override was a claim only one of them could be right about. A runtime the object does not name falls through to tier resolution for that agent, exactly as an agent with no override does, so adopting the form for one runtime never changes what another resolves. Install-time frontmatter baking now selects by the runtime being installed for rather than the statically-configured one; spawn-time selection still reads the persisted `runtime` key pending #4505. Both readers share one parser. (#4669)
