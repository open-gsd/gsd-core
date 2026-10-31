---
type: Fixed
pr: 5520
---
**Secret-read guard now blocks git command lines that run a command printing `.env`** — `git -c sequence.editor='cat .env; true' rebase -i`, `git rebase -x 'cat .env'`, `git -c alias.r=rebase r -x 'cat .env'`, `git submodule foreach 'cat .env'` and similar commands were allowed. The guard now scans:
- every command-valued `-c` key (editors, `core.sshCommand`, `core.fsmonitor`, diff, filter and merge drivers, `gpg` programs, tool, trailer, tar and send-email commands, transport hooks, `hook.<name>.command`, `!` submodule updates, and credential helpers given as `!`, an absolute path, shell metacharacters or a `store` helper with a secret file; the last three go beyond the original `!`-only list on purpose);
- a `-c` value naming a secret file;
- aliases, expanded the way git expands them, with the words after them and through other aliases;
- the subcommand options and trailing commands git runs;
- `ext::` URLs;
- ssh's `ProxyCommand`-style `-o` values.
