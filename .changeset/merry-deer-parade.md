---
type: Fixed
pr: 0
---
**`uat render-checkpoint` accepts a UAT file under a symlinked planning store** — with `.planning` symlinked into a separate repository (the layout `gsd-planning-out-of-repo.md` prescribes) the command refused the file with "Path escapes allowed directory"; planning artifacts are now contained against the planning store while every other path keeps the project-root check, and verification reads its project root from the resolved context so `--project-dir` no longer depends on a process-wide global. (#6820)
