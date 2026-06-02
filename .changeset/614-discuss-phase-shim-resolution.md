---
type: Fixed
pr: 0
---
**`/gsd:discuss-phase` now honors `workflow.discuss_mode: assumptions` on shim-only installs** — mode routing (and the codebase-drift gate) resolve `gsd-tools` via the runtime shim instead of the bare PATH command, so a missing PATH binary no longer silently falls back to standard discuss mode.
