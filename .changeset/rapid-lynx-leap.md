---
type: Fixed
pr: 4893
---
**init.manager resolves archived phase directories** — a phase archived to .planning/milestones/vX.Y-phases/ with a passing verification reported no_directory / phase_complete: false (indistinguishable from never started), so /gsd-autonomous's default discovery skipped or mis-sequenced it; the manager's phase lookup now threads the convention through findPhaseInternal, which resolves live directories first and archived milestones second. (#4801)
