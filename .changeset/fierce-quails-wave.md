---
type: Fixed
pr: 1442
---
**Antigravity config-dir resolution no longer shadows the active runtime** — when more than one of `~/.gemini/antigravity`, `antigravity-ide`, or `antigravity-cli` exists, GSD now resolves to the directory it actually installed into (marked by `gsd-core/VERSION`) instead of whichever directory existed first. Fixes silent misresolution where a CLI user who also had the Antigravity-IDE dir present was sent to the legacy dir (regression from #217).
