---
type: Fixed
pr: 1408
---
**`gsd-tools query agent-skills` no longer silently drops a configured agent's skills under cwd/workstream drift** — resolution is now anchored to the nearest ancestor `.planning/` (so it works from any descendant subdirectory), `loadConfig` falls back to the project-root config when `GSD_WORKSTREAM` points at a missing workstream, and a configured agent that resolves to no skills now emits a stderr warning plus `configured`/`reason` fields in the `--json` output instead of returning an empty block with no signal. (#1408)
