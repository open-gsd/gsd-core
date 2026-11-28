---
type: Fixed
pr: 6559
---
**Keep markerless Codex configs parseable during cleanup** — uninstalling or reinstalling could write a second `[agents]` table when the original mixed known and unknown keys, leaving `config.toml` invalid. (#5991)
