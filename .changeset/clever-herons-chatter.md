---
type: Changed
pr: 4585
---
**Planner stall detection can now be disabled explicitly** — set `planner.stall_detection_enabled` to `false` to use the runtime-native completion wait without watchdog polling; the default remains enabled, and disabling it gives up bounded automatic recovery.
