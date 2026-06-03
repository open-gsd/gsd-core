---
type: Fixed
pr: 636
---
**`/gsd-plan-phase` post-planning gap analysis now runs on global installs** — the §13e gap-analysis step resolves `gsd-tools` via the runtime launcher instead of a hardcoded `$HOME` path, so it no longer falsely reports the tool as "not found" (and silently skips the gap report) when only a global/shim install is present.
