---
type: Changed
pr: 0
---
**Committing verbs take the resolved project context and run git in the worktree you are in** — `commit`, `commit-to-subrepo`, `pr-subrepo`, `check-commit`, `commit-docs-guard` and `stats` now read their git root from the same resolved context as every other verb instead of re-deriving a directory string, so `uat complete-session` run from a linked worktree no longer commits its UAT file into the main checkout (it refuses like `commit` does), and `commit-to-subrepo` finds its sub-repo from any subdirectory of the workspace. (#6821)
