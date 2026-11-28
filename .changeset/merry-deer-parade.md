---
type: Fixed
pr: 6824
---
**`uat render-checkpoint` accepts a UAT file under a symlinked planning store** — with `.planning` symlinked into a separate repository (the layout `gsd-planning-out-of-repo.md` prescribes) the command refused the file with "Path escapes allowed directory"; planning artifacts are now contained against the planning store while every other path keeps the project-root check. (#6820)
