---
type: Fixed
pr: 0
---
**`gsd-intel-updater` now writes the canonical intel filenames the `gsd-tools intel` CLI actually reads** — the agent was instructed to emit short names (`files.json`, `apis.json`, `deps.json`) and a markdown `arch.md`, but the intel library reads only `file-roles.json`, `api-map.json`, `dependency-graph.json`, and `arch-decisions.json` (JSON). After `/gsd:map-codebase --query refresh` the output was orphaned, so `intel status`/`validate` reported the files missing and `intel query` returned nothing. The agent now emits the canonical long names and structured `arch-decisions.json`. (#1000)
