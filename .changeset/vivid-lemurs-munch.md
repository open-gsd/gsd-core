---
type: Fixed
pr: 847
---
Corrected the installer `--help` profile skill counts: `core` now shows 8 (was 7) and `standard` shows 14 (was 13), both derived from `PROFILES` so they can't drift again; the `full` line drops the stale hardcoded `66` for `all skills`. (#834)
