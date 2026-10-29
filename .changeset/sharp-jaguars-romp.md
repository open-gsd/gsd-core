---
type: Fixed
pr: 5394
---
**Family-only GSD commands work through MCP** — `gsd_invoke_command` accepts an omitted or empty subcommand, so commands such as `config-path` are reachable while required family and supplied-field type validation remain enforced.
