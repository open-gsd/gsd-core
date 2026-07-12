---
type: Changed
pr: 2165
---
**Installing GSD into Antigravity now writes the `permissions.allow` rules its CLI documents** — so GSD's own reads and hooks aren't stuck on interactive prompts — and registers GSD's companion MCP server via a standalone `mcp_config.json` (best-effort: Antigravity's raw config schema isn't published, so this uses the Gemini-CLI-successor format). Antigravity's install is now driven by its negotiated capability descriptor instead of hardcoded runtime special-cases. (#2096)
