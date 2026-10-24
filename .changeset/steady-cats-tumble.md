---
type: Fixed
pr: 5520
---
**Secret-read guard now blocks the remaining command-valued git `-c` keys** — `sequence.editor`, `core.editor`, `core.sshCommand`, `core.fsmonitor`, diff textconv/command, filters, `gpg` programs, merge drivers, credential helpers (`!`, an absolute path, shell metacharacters or the built-in `store` helper given a secret file; the last three go beyond the original `!`-only list on purpose), difftool/mergetool/browser/man/guitool commands, trailer, tar and send-email commands, askPass/gitProxy programs, remote upload/receive-pack, `!` submodule updates and the pack-objects, recent-objects and alternate-refs hooks could run a command that printed `.env`, and a plain alias is now checked as the git command it expands to, so a `-c` inside it (`git -c alias.x='-c core.fsmonitor="cat .env" status' x`) is caught too.
