---
type: Changed
pr: 1809
---
**Internal: companion MCP server module (interface points 1 + 5)** — `handleMessage`/`runServer` (new `src/mcp-server.cts`) is a minimal, dependency-free stdio JSON-RPC 2.0 server exposing `gsd_invoke_command` (→ the command-routing hub) + `gsd_read_state`/`gsd_write_state` (→ the Phase 3 stateIO seam), so any MCP-consuming host can drive GSD with no bespoke plugin (ADR-1239 Phase C-2 / #1681 slice 3a). Bin entry / packaging deferred to slice 3b. No user-facing change — the server is not yet wired to a bin entry.

<!-- docs-exempt: internal server module; user-facing doc lands with slice 3b's bin entry -->
