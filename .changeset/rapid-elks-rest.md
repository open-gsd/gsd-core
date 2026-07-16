---
type: Fixed
pr: 2299
---
**`query config-get` now returns capability-registry defaults for absent keys** — keys declared with a default in the capability registry (e.g. `workflow.security_enforcement`, which defaults to `true`) previously reported "Key not found" (exit 1) when missing from config.json, diverging from the runtime's own resolver and letting `... || echo false` guards silently read the security gate as disabled. config-get now resolves these through the same registry defaults the runtime uses. (#2256)
