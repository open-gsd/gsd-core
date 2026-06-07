---
type: Changed
pr: 795
---
Make per-runtime config-mutation dispatch in the installer explicit: a new runtime config adapter registry maps each supported runtime to a typed config intent (install surface, shared-settings gate, finish-phase permission writer), and `install()`/`finishInstall()` dispatch by resolved intent instead of inline `runtime === '...'` branching. Behavior-preserving; unknown runtimes now fail loudly. (#60)

<!-- docs-exempt: internal behavior-preserving refactor of bin/install.js config dispatch into a dedicated registry module; no user-facing behavior change -->
