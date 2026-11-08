---
type: Fixed
pr: 6001
---
**Commit and branch guards now recognise `git --no-advice`, `--config-env` and `--attr-source`** — a `git commit` or `git checkout -b` written with one of these global options before the subcommand was classified as not-a-commit and slipped past the commit-message and workflow guards. (#5821)
