---
type: Fixed
pr: 5618
---
**GSD's git calls now act on the repository the working directory names, not the one an inherited `GIT_DIR` points at** — run from a git hook or a wrapper that exports `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` or the other repo-location variables, `execGit` and every other runtime git spawn (statusline, guards, phase allocation, graphify auto-update, `/gsd-pr-branch`) read or changed that repository's state instead. They now drop those variables; `GIT_CONFIG*` still passes through. A setup that deliberately exports `GIT_DIR`/`GIT_WORK_TREE` for GSD (a bare-repo dotfiles checkout, say) now gets cwd-based discovery; a caller of `execGit` can still pass them explicitly in `opts.env`. (#5548)
