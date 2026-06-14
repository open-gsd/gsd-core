---
type: Fixed
pr: 1198
---
**Forking workflows target wrong base branch on `master` repos when `origin/HEAD` is unset** — `execute-phase`, `quick`, `ship`, `complete-milestone`, and `pr-branch` detection bash fell through to a hardcoded `main` fallback whenever `origin/HEAD` was absent (common in `git init` + `remote add` + `fetch` without `set-head`, CI checkouts, and worktrees), causing GSD to fork phase branches off a non-existent `main` on `master` repos. Replaced with a single `gsd_run query git.base-branch` resolver that walks the full precedence ladder: config override → `origin/HEAD` symref → `git remote show origin` → local branch presence → `"main"`. (#1198)
