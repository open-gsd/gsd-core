---
type: Changed
pr: 1303
---
**Isolated-executor recovery now fails safe** — when an isolated (worktree) executor run is rejected (you decline to merge it) or over-reached the requested scope, `/gsd:execute-phase` and `/gsd:quick` no longer default or propose recovery by editing the primary checkout (`main`). The orchestrator halts safely and offers a fresh, narrowly-scoped worktree or inspect/discard; editing the primary checkout requires explicit, clearly-labeled confirmation. (#1292)
