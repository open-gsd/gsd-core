---
type: Fixed
pr: 2227
---
**`/gsd-debug` no longer stalls on a phantom background handoff** — the orchestrator treated the foreground session-manager spawn as a background task and queried its agent ID via TaskOutput (which needs a task ID), then waited on a handoff that was never queryable. The workflow now states the spawn is foreground/blocking, forbids passing an agent ID to TaskOutput, and gives a lost-handoff recovery path. (#2196)
