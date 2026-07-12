---
type: Changed
pr: 2166
---

**Augment Code now installs through its capability descriptor, with a native MCP companion** — installing GSD into Augment registers the GSD companion server in Augment's `settings.json` `mcpServers` and drives command/skill/agent conversion from Augment's negotiated descriptor instead of hardcoded runtime special-cases. (#2097)
