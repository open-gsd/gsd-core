---
type: Changed
pr: 6649
---
**Keenable is now an opt-in web-discovery research provider** — it sits after Serply and before the built-in `websearch` terminal, and is only used when `keenable_search` is on. GSD sets it from `KEENABLE_API_KEY` or `$GSD_HOME/.gsd/keenable_api_key`, or you can set `keenable_search: true` yourself after registering the Keenable MCP server as `keenable`. With neither, nothing is sent to Keenable. Researcher agents gain the `mcp__keenable__*` grant and a `keenable → mcp__keenable__search_web_pages` dispatch row. (#6563)
