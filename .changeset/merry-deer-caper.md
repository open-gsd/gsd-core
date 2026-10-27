---
type: Fixed
pr: 5489
---
**Agent task commits no longer sweep in files another session staged** — prompts, workflows, references and the Pi `gsd-debug` skill ran a bare `git commit` that records the whole index, so a foreign staged file landed in a commit whose message described only the task; task commits now name their paths after a `--` pathspec. `/gsd-fast` now stages and commits only the current directory instead of the whole repository. (#5211)
