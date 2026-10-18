---
type: Fixed
pr: 5520
---
**Secret-read guard now blocks the remaining command-valued git `-c` keys** — `sequence.editor`, `core.editor`, `core.sshCommand`, `core.fsmonitor`, diff textconv/command, filters, `gpg` programs, merge drivers and `!` credential helpers could run a command that printed `.env`.
