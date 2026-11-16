---
type: Fixed
pr: 0
---
**The secret-read guard no longer denies a grep pattern, an exclusion value or a jq program that merely names a secret file** — `grep -n 'packages/db/.env.local' src/setup.ts`, `grep -rn token . --exclude=.env` and `jq '.env.X' settings.json` were blocked although the command opens none of those names. Every file the command does open, a pattern file (`-f`), `--exclude-from`, and any command with an option the guard does not know stay checked. (#5884)
