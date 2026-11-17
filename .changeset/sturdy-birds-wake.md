---
type: Fixed
pr: 0
---
**A hard kill while gsd updates `.gsd/.gitignore` no longer leaves an untracked temp file in `git status`** — the ignore-file merge now stages its replacement inside a self-ignoring directory and the owner adds a `/.gitignore.tmp-*` rule. (#5856)
