---
type: Fixed
pr: 0
---
**`/gsd:init` no longer reports agents as missing on OpenCode and other non-Claude runtimes** — `getAgentsDir()` now resolves the per-runtime global config directory instead of always checking the Claude path, and init diagnostics surface `agent_runtime` and `agents_dir`.
