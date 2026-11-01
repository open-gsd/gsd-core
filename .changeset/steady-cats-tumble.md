---
type: Fixed
pr: 5520
---
**Secret-read guard now blocks git command lines that run a command printing `.env`** — command-valued `-c` keys and the same config set in the environment on the command line (`GIT_CONFIG_*`, `--config-env`, `GIT_EDITOR`-style variables), aliases, subcommand options and trailing commands, `ext::` URLs and ssh's `ProxyCommand`-style options could run `cat .env` unchecked, as in `git -c sequence.editor='cat .env; true' rebase -i` or `git rebase -x 'cat .env'`.
