---
type: Fixed
pr: 707
---
**`/gsd:graphify`, `/gsd:import`, and planning agents now resolve `gsd-tools` on global/shim-only installs** — agent and command surfaces that invoked a hardcoded `$HOME/.claude/...gsd-tools.cjs` path now route through the resolved `gsd_run` launcher, so the step no longer reports the tool "not found" when there is no project-local runtime.
