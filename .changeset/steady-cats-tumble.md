---
type: Fixed
pr: 5520
---
**Secret-read guard now blocks git command lines that run a command printing `.env`** — command-valued `-c` keys and the same config set in the environment on the command line (`GIT_CONFIG_*`, `--config-env`, `GIT_EDITOR`-style variables), aliases, subcommand options and trailing commands, `ext::` URLs and ssh's `ProxyCommand`-style options could run `cat .env` unchecked, as in `git -c sequence.editor='cat .env; true' rebase -i` or `git rebase -x 'cat .env'`, and a command too large to check now blocks as `command-too-complex` instead of crashing the hook. The guard also reads a shell's `-c` script wherever `-c` sits among its options, a script fed to `source` or a shell through `/dev/stdin`, what `printf` and `echo -e` write into a shell or `xargs`, `dd if=`, a `time VAR=…` prefix, and a command behind a wrapper it does not list (`caffeinate git -c core.fsmonitor='cat .env' status`, `docker exec c sh -c 'cat .env'`).
