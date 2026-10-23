---
type: Security
pr: 5637
---
**Typed text can no longer close the argument-capture heredoc on an installed GSD** — text containing a line `GSD_ARGS_END` ended the heredoc that captures what you type after a command, and the lines after it ran as shell. Each install now writes its own random terminator into the workflows, commands and skills it installs, so typed text that does not know it stays data. The Claude Code plugin, the Pi npm package, the MCP catalog, OpenCode and Kilo package mode and a source checkout run in place are not written by the installer and keep the fixed terminator; an install made before this change gets its random terminator the next time you reinstall.
