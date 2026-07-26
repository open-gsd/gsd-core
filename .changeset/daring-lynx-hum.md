---
type: Changed
pr: 2558
---
**Every workflow now carries response-language coverage** — previously uncovered workflows (including `/gsd-review` and lazy-loaded mode/step files) now apply a shared or inline directive covering narration between tool calls, report templates, and subagent propagation; a new CI lint (`lint:response-language`) prevents future workflows from shipping uncovered. (#2529)
