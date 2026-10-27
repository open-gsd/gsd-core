---
type: Fixed
pr: 5747
---
**GSD's git calls now act on the repository the working directory names, not the one an inherited `GIT_DIR` points at** — run from a git hook or a wrapper that exports `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` or the other repo-location variables, `execGit` and the other git spawns in `src/` and `hooks/` (statusline, guards, phase allocation, graphify auto-update) and `/gsd-pr-branch`'s sub-repo dirty scan read or changed that repository's state instead. They now drop those variables (the rest of `/gsd-pr-branch`'s bare `git` calls are not covered); `GIT_CONFIG*` still passes through. A setup that deliberately exports `GIT_DIR`/`GIT_WORK_TREE` for GSD (a bare-repo dotfiles checkout, say) now gets cwd-based discovery; a caller of `execGit` can still pass them explicitly in `opts.env` (the commit-docs guard does so for `GIT_INDEX_FILE`, which git sets inside the pre-commit hook). (#5548)
