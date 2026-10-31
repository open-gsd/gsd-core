---
type: Fixed
pr: 5489
---
**Task commits that name their files no longer sweep in files another session staged** — the executor, debugger and debug session manager prompts, the audit-fix, validate-phase and complete-milestone workflows, the git-integration reference and the Pi `gsd-debug` skill ran a bare `git commit`, which records the whole index, so a foreign staged file landed in a commit whose message described only the task; they now name their paths after a `--` pathspec. `/gsd-fast` now stages and commits only the current directory instead of the whole repository (#5211).
