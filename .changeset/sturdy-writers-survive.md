---
type: Fixed
pr: 0
---
**Large-file GSD writer agents no longer fail to write their output on OpenCode** — `gsd-research-synthesizer`, `gsd-planner`, `gsd-executor`, `gsd-domain-researcher`, `gsd-project-researcher`, and `gsd-ui-researcher` now carry the same truncation-resilient write contract added for `gsd-phase-researcher` in #214. Each keeps its single-write default and falls back to an incremental, sentinel-based Write→Read→Edit sequence only when a runtime truncates an oversized tool call (upstream opencode#18108), instead of doom-looping on `JSON parsing failed: Expected '}'`.
