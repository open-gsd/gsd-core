---
type: Changed
pr: 0
---
**Committing verbs take the resolved project context and run git in the worktree you are in** — `commit`, `commit-to-subrepo`, `pr-subrepo`, `check-commit`, `commit-docs-guard` and `stats` now read their git root from the same resolved context as every other verb instead of re-deriving a directory string, so `uat complete-session` run from a linked worktree no longer commits its UAT file into the main checkout (it reports `committed: false` with the refusal reason, exit 0, since the UAT file itself is written), `stats` counts commits in the checkout you are in, and a project nested inside the worktree commits its own `.planning/` files instead of an empty path. (#6821)
