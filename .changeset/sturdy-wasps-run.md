---
type: Fixed
pr: 2447
---
**`close_phase_todos` no longer leaves moved todos as phantom unstaged deletions in `git status`** — the workflow step moved resolved todos from `.planning/todos/pending/` to `.planning/todos/completed/` with a plain `mv`, then committed by listing only the destination directory in `--files`. Git's index still tracked the moved file at its old `pending/` path, so the deletion was never staged and the moved-away file lingered as an unstaged deletion in `git status` until some later broad `git add -A` happened to catch it. The step's commit `--files` list now includes BOTH directories so `git add .planning/todos/pending/` stages the deletion atomically with the new `completed/` copy in the same commit. (#2415)
