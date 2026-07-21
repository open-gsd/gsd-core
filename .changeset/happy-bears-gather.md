---
type: Security
pr: 2478
---
**Patched a transitive denial-of-service advisory in the production dependency tree** — `body-parser` reached GSD via the Claude Agent SDK's MCP dependency and, on versions through 2.2.2, silently stopped enforcing request size limits when given an invalid limit value (GHSA-v422-hmwv-36x6). Pinned to >=2.3.0. (#2470)
