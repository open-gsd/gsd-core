---
type: Changed
pr: 2558
---
**Every workflow now carries response-language coverage** — the 44 workflows that had no `response_language` directive (including `/gsd-review`) now @-reference a shared directive covering narration between tool calls, report templates, and subagent propagation; a new CI lint (`lint:response-language`) prevents future workflows from shipping uncovered. (#2529)
