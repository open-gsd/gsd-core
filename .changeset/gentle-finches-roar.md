---
type: Fixed
pr: 4610
---
**`/gsd-pr-branch` no longer preserves nested `<milestone>-phases/` directories as structural** — the milestones alternative in `STRUCTURAL_RE` was matching that entire subtree, not just files directly under `.planning/milestones/`. Default mode now filters those directories out like other phase-plan noise; milestone-scoped projects will see smaller PR-branch diffs.

The filter's path list is newline-delimited end to end, so a milestone slug containing a space (`.planning/milestones/My Milestone-phases/`) is filtered correctly instead of being word-split into fragments that match nothing.
