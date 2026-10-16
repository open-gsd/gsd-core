---
type: Fixed
pr: 5478
---
**Secret-read guard now blocks command-valued git `-c` config** — `git -c alias.x='!cat .env' x` and `git -c diff.external='cat .env' diff` were allowed and printed the protected file.
