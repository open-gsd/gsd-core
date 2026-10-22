---
type: Security
pr: 5637
---
**Typed text can no longer close the argument-capture heredoc on an installed GSD** — text containing a line `GSD_ARGS_END` ended the heredoc that captures what you type after a command, and the lines after it ran as shell. Each install now writes its own random terminator into the workflows, commands and skills it installs, so typed text that does not know it stays data. The Claude Code plugin, the Pi npm package and a source checkout run in place are not installed by GSD and keep the fixed terminator.
