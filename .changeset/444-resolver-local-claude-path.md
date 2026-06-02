---
type: Fixed
pr: 476
---
**`gsd_run` now resolves the launcher for project-local `--claude --local` installs** — the resolver preamble now also checks `<repo>/.claude/gsd-core/bin` (immediately after the repo-root `gsd-core/bin` check and before PATH and global `$HOME/.claude` fallbacks).
