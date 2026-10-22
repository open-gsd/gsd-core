---
type: Fixed
pr: 5520
---
**Secret-read guard now blocks the remaining command-valued git `-c` keys** — `sequence.editor`, `core.editor`, `core.sshCommand`, `core.fsmonitor`, diff textconv/command, filters, `gpg` programs, merge drivers, credential helpers, difftool/mergetool/browser/man/guitool commands, trailer, tar and send-email commands, askPass/gitProxy programs, remote upload/receive-pack, `!` submodule updates and the pack-objects, recent-objects and alternate-refs hooks could run a command that printed `.env`.
