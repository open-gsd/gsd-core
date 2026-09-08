---
type: Fixed
pr: 4537
---
**`/gsd-pr-branch` no longer silently drops a planning-only commit that mixes a structural `.planning/` path (STATE.md, ROADMAP.md, etc.) with a transient or other planning path** — such a commit matched none of the classification's four arms and was excluded, which could break `STATE.md`'s per-commit revision chain in default mode. A fifth arm now covers this shape and includes it, same as a mixed code+planning commit. (#4447)
