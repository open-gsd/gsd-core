---
type: Added
pr: 5343
---
**OpenCode 2.x installer output and a complete OpenCode uninstall (epic #5331, Phase 2)** — your annotated `opencode.jsonc` keeps its comments through install, update and uninstall; the GSD MCP companion no longer lists every GSD command a second time (existing installs are converged by a new migration); agents carry tool restrictions from their `tools:` allowlist; and `--uninstall` now removes everything GSD created on OpenCode 1.x and 2.x, including the hook helpers, install state, the GSD MCP entry and the machine-wide defaults it had set, while leaving your own files untouched.
