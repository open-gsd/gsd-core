---
type: Changed
pr: 2195
---
**ZCode's install is now driven and regression-tested through its capability descriptor** — ZCode joins the dogfooded declarative-adapter reference hosts with a byte-identical install, and its shared-hooks exclusion is folded onto `hostBehaviors` instead of a hardcoded runtime branch. (Hook-automation and MCP upgrades remain blocked on ZCode publishing its on-disk config formats.) (#2101)
