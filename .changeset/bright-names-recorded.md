---
type: Fixed
pr: 0
---
**plan-phase records the phase name and plan count in STATE.md** — step 13b passed `--name "${PHASE_NAME}"` to `state planned-phase` with `PHASE_NAME` never set, so STATE.md recorded an empty phase name; the step now reads the phase name and plan count from `find-phase` and stops when the phase is not found. (#6257)
