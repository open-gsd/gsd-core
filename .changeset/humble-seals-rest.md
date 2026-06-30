---
type: Added
pr: 1810
---
**`gsd-mcp-server` — companion MCP server (interface points 1 + 5)** — a new bin command (`npx @opengsd/gsd-core gsd-mcp-server`) runs a stdio JSON-RPC 2.0 MCP server exposing `gsd_invoke_command` (→ the GSD command-routing hub) + `gsd_read_state` / `gsd_write_state` (→ `.planning/` state), so any MCP-consuming host (Claude Code, Codex, OpenCode, VS Code, Gemini CLI, Cursor, Cline, Hermes) can drive GSD with no bespoke plugin (ADR-1239 Phase C-2 / #1681). Dependency-free (hand-rolled JSON-RPC). How-to: `docs/how-to/connect-gsd-mcp-server.md`.
