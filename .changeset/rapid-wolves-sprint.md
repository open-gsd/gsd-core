---
type: Fixed
pr: 0
---
**Optional flags in the code-review, codebase-map, reviewer-instance and cross-runtime workflow blocks now reach the CLI under zsh** — `--since`, `--files`, `--agent` and `--executor-runtime` were passed as one joined expansion that zsh treats as a single argument, so the option was silently dropped (the code-review scope ignored the last-review commit, the codebase map was stamped without its files, the reviewer instance ran without its agent); each is now two conditional expansions, and a scan fails any new joined flag. (#6048)
