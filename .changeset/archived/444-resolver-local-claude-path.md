---
type: Fixed
pr: 476
---
**`gsd_run` now resolves the launcher for project-local `--claude --local` installs** — the resolver preamble now also checks `<repo>/.claude/get-shit-done/bin` (immediately after the repo-root `get-shit-done/bin` check and before PATH and global `$HOME/.claude` fallbacks).
