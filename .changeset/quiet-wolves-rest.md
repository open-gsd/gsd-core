---
type: Fixed
pr: 5160
---
**`effort sync` and `resolve-execution` use a project-local Claude install's agents** — they no longer read the global agents directory when running from a local install, and an empty selected directory explains why nothing was synced. (#4988)
