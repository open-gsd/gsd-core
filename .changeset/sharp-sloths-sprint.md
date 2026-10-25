---
type: Fixed
pr: 5643
---
**`/gsd-code-review --files` no longer skips every file on Windows Git Bash** — the repository-containment check compared git's `C:/...` root with `realpath`'s `/c/...` path, so every entry looked outside the repository and the scope ended at 0 files. Both sides are now normalized with `cygpath -m` and compared on a path boundary, which also stops a sibling directory sharing the repository's name prefix from being accepted on any platform. (#5519)
