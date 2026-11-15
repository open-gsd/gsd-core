---
type: Changed
pr: 0
---
**`/gsd-new-project` and `/gsd-settings` now ask which executors may run your plans** — choose `gsd-executor` only, or allow other executor agents installed on your runtime that a plan names with `agent_hint:` (the default); new project configs now record the choice as `workflow.agent_hint_routing` instead of leaving it implicit (#6211).
