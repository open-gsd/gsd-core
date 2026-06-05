---
type: Fixed
pr: 642
---
**`/gsd-import`, `/gsd-plan-review-convergence`, and `/gsd-spec-phase` now run on global installs** — these workflows resolve `gsd-tools` via the runtime launcher instead of a hardcoded `$HOME` path, so they no longer falsely report the tool as "not found" (and stop short) when only a global/shim install is present and no project-local runtime exists.
