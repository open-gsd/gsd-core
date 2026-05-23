---
type: Fixed
pr: 142
---
**Runtime aliases now canonicalize through one shared policy module** — runtime identity inputs from `GSD_RUNTIME` and `.planning/config.json` are normalized through a shared alias manifest used by both CJS and SDK paths. This fixes runtime-aware behavior when users set App/CLI variants like `codex-app` or `codex-cli`, and prevents drift between slash-command emission and SDK runtime detection.
