---
type: Fixed
pr: 5588
---
**plan-phase now names the stall-detection config key where it is used** — the dispatch/wait gates referred to `PLANNER_STALL_DETECTION_ENABLED` without saying which config key feeds it, so an orchestrator resolving it guessed (`workflow.plan_stall_detection`) and failed with "Key not found". Each gate now names `planner.stall_detection_enabled` and the helper step that resolves it. (#5451)
