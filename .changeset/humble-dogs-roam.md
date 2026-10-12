---
type: Fixed
pr: 5343
---
**`opencode.jsonc` comments and trailing commas survive install and uninstall, and OpenCode uninstall is complete (#5333, #5334, #5335)** — uninstall used to leave 8 hook helpers, the install state and journal, an empty `settings.json`, the `mcp.gsd` entry and the `~/.gsd/defaults.json` it had written; the config rewrite used to drop every comment.
