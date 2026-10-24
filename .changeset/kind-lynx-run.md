---
type: Fixed
pr: 5672
---
**`/gsd-code-review` and `/gsd-review` now find their helper modules in a global install** — the flag parser, depth resolver, fallow normalizer and plan-coverage helper were loaded relative to the current directory, so a global install silently dropped `--fix`, `--all`, `--auto`, `--depth` and `--files`, halted the depth step, and wrote empty plan-coverage files; each step now resolves its module from the installed runtime (or a local install) and names the searched locations when it finds none. (#5640)
