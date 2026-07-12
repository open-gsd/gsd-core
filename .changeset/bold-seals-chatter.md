---
type: Fixed
pr: 0
---
**`stale-bake-guard` hermeticity fix (test-isolation)** — the readGsdEffectiveModelOverrides subtest no longer reads the developer's real `~/.gsd/defaults.json`; the resolver now accepts a homedir seam so the test sandboxes HOME. (#2152)
