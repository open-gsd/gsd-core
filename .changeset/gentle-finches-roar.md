---
type: Fixed
pr: 4610
---
**`/gsd-pr-branch` no longer preserves nested `<milestone>-phases/` directories as structural** — the milestones alternative in `STRUCTURAL_RE` was matching that entire subtree, not just files directly under `.planning/milestones/`. Default mode now filters those directories out like other phase-plan noise; milestone-scoped projects will see smaller PR-branch diffs.
