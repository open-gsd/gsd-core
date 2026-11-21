---
type: Fixed
pr: 0
---
**plan-phase records the phase name and plan count in STATE.md** — step 13b passed `--name "${PHASE_NAME}"` and `--plans "${PLAN_COUNT}"` to `state planned-phase` with neither variable ever set (each workflow fence is its own shell), so STATE.md recorded no phase name; the step now assigns the phase number placeholder, reads the curated display name from `roadmap.get-phase` and the plan count from `find-phase` (both workstream-scoped), and stops when the plan count cannot be read. (#6257)
