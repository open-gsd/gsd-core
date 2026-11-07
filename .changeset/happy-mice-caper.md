---
type: Changed
pr: 5117
---
**Config resolution now exposes per-key provenance and honors section barriers** — a new read-only owner reports the producing layer for project and runtime-setting values, while the assembled loader no longer recreates lower/default projections beneath an explicitly non-object section. The default-on planner watchdog remains the documented fail-safe exception.
