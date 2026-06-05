---
type: Fixed
pr: 645
---
**Post-execution codebase-drift detection no longer silently disables itself on shim-only installs** — `codebase-drift-gate` now resolves `gsd-tools` through the runtime shim launcher (`gsd_run`) instead of the bare PATH binary, which exited 127 (hidden by `2>/dev/null`) and marked the gate skipped whenever `gsd-tools` wasn't on `PATH`. The gate remains fully non-blocking.
