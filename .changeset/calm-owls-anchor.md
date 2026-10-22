---
type: Security
pr: 5637
---
**Typed text can no longer close the argument-capture heredoc** — text containing a line `GSD_ARGS_END` ended the heredoc that captures what you type after a command, and the lines after it ran as shell, in every workflow on every runtime. Each install now writes its own random terminator into the workflows, commands and skills it installs, so typed text that does not know it stays data.
