---
type: Added
pr: 1929
---
<!-- docs-exempt: Phase 5 (#1682) Slice 1a; consolidated Phase 5 (Embeddable Orchestration) docs land with phase completion. -->
**OpenCode installs now auto-register the GSD companion MCP server (`mcp.gsd`)** — `--opencode` install writes a `mcp.gsd` entry (local stdio → `gsd-mcp-server`) into `opencode.json`, so OpenCode drives GSD's command + planning-state surface over MCP with no bespoke plugin (ADR-1239 Phase D / #1682). Idempotent and non-clobbering; a user-defined `mcp.gsd` is preserved. (#1682)
