---
type: Added
pr: 0
---
**Deep verification before UAT** — set `workflow.deep_verify` and `/gsd-verify-work` first has an agent enumerate interaction-level behaviors from the plan, summary and changed files, run each one it can through a browser MCP server, and leave you only judgment items, failed behaviors and anything it could not run; `workflow.deep_verify_all_phases` widens it beyond UI phases (#3858).
