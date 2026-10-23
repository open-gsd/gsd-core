---
type: Fixed
pr: 5592
---
**`gsd_run` now stays resolvable for the rest of a Claude Code session** — the resolver's PATH persistence wrote to `$CLAUDE_ENV_FILE`, but Claude Code provides that variable only to SessionStart (and Setup, CwdChanged, FileChanged) hooks, never to a workflow Bash block, so a later block that called `gsd_run` without re-including the resolver got `command not found` (often hidden behind a `|| echo <fallback>`). A new managed `gsd-path-export.js` SessionStart hook, registered for Claude Code settings.json and plugin installs, appends the installed `gsd-core/bin` directory to the env file Claude Code hands it; it takes effect from the next session after install. (#5465)
