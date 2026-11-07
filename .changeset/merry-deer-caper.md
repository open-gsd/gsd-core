---
type: Fixed
pr: 5489
---
**Task commits that name their files no longer sweep in files another session staged** — a bare `git commit` records the whole index. A foreign staged file therefore landed in a commit whose message described only the task. The executor, debugger and debug session manager prompts now name their paths after a `--` pathspec. So do the audit-fix, validate-phase and complete-milestone workflows. So do the git-integration reference, the async-external-jobs recipe and the Pi `gsd-debug` skill. The stop-tracking recipe for `.planning/` now refuses while unrelated paths are staged. `/gsd-complete-milestone` now commits from the repository top. It stops when it finds more than one staged `.planning` REQUIREMENTS.md deletion. `/gsd-fast` now stages and commits only the current directory instead of the whole repository (#5211).
