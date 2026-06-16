---
type: Changed
pr: 1315
---
**Intel and loop-hook rendering now honor the single capability `active` state** — `gsd-tools intel` gates through the shared resolver (consistency; intel stays governed by `intel.enabled`), and loop-hook rendering now suppresses a config-disabled capability's hooks via the capability-level `active` gate (fail-closed), not just per-hook `when`. (#1315)
