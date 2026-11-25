---
type: Changed
pr: 6672
---
**Serply is now an opt-in web-discovery research provider.** Set `SERPLY_API_KEY` or create `~/.gsd/serply_api_key`, register the Serply MCP server as `serply`, and the researcher agents reach it through `mcp__serply__google_search`, after Brave and before the built-in `websearch` fallback. `serply_search` overrides the auto-detection like the other provider flags. Projects without a Serply key see no change. (#4942)
