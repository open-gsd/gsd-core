---
type: Changed
pr: 6497
---
**Config resolution now exposes per-key provenance and honors section barriers** — a new read-only owner reports the producing layer for project and runtime-setting values, while the assembled loader no longer recreates lower/default projections beneath an explicitly non-object section. Init/docs payloads make only absent flags explicit as false and use the manifest timeout default; configured non-boolean values retain their prior representation. An object section in the workstream config overrides a non-object section in the root config, as the assembled loader merges them. A null workflow disables inherited quality gates and a null review removes default prompt trimming. The default-on planner watchdog remains the documented fail-safe exception.
