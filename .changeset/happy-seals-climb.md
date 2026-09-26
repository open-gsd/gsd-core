---
type: Changed
pr: 4994
---
**Serply is now an opt-in web-discovery research provider.** Set `SERPLY_API_KEY` or create `~/.gsd/serply_api_key` and the researcher agents reach it through the `mcp__serply__*` tool surface, after Brave and before the built-in `websearch` fallback; `serply_search` overrides the auto-detection like the other provider flags. Projects without a Serply key see no change. (#4942)
