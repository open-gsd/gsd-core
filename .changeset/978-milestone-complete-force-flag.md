---
type: Fixed
pr: 0
---
**`gsd-tools milestone complete --force` now actually overrides the unstarted-phase guard** — the dispatcher never parsed `--force`, so the guard's own documented escape hatch was inert. (#978)
