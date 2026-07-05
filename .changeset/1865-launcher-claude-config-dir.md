---
type: Fixed
pr: 2024
---
**The runtime launcher now honors `CLAUDE_CONFIG_DIR`** — the `gsd_run` preamble embedded in every workflow/agent resolved the Claude global install only at `$HOME/.claude/gsd-core/bin/`, while the installer honored `CLAUDE_CONFIG_DIR`, so a global install redirected via `CLAUDE_CONFIG_DIR` was invisible to every `gsd_run` call (every GSD command failed with `gsd-tools.cjs not found`). The Claude resolver arm now uses `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` — matching the installer and the other runtimes' `${VAR:-default}` pattern — so a custom `CLAUDE_CONFIG_DIR` is found and the default `$HOME/.claude` path is unchanged. Re-synced into all 95 workflows/agents; two capped workflows trimmed to stay under their byte budgets. (#1865)
