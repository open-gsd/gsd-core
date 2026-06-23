---
type: Added
pr: 1448
---
Added a validated `gsd-tools worktree record-agent` writer verb that appends a per-agent entry to the wave cleanup manifest, validating every field at write time with the same rules the `cleanup-wave` reader enforces (write-strict `--agent-id`) and failing loudly with a recovery hint instead of silently appending an under-populated entry. The execute-phase orchestrator now records each spawned worktree through this verb. (#1448)
