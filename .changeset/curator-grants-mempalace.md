---
type: Fixed
pr: 6676
---
**The MemPalace curator agent can now actually call its MemPalace MCP tools** — its instructions told it to use the `mempalace_*` MCP tools but its `tools:` allowlist never granted them, so on tool-allowlist runtimes every instructed MCP call was silently unexecutable (the capability's `onError: skip` hid the gap); the shipped agent now carries `mcp__mempalace__*` in both variants, a static check pins that any agent naming `mempalace_*` calls grants the MemPalace server, and the settled server name is documented. (#6455)
