---
type: Changed
pr: 1311
---
**Capability state now reports a tri-state `active`** — `gsd-tools capability state` adds an `active` field per capability (installed && surfaced && config-enabled), alongside the existing `enabled` (installed && surfaced). Internal `isCapabilityActive(capId, cwd)` lets consumers honor the single resolved on/off answer. (#1311)
