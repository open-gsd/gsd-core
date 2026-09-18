---
type: Fixed
pr: 4831
---
**`/gsd:secure-phase`, `/gsd:validate-phase`, `/gsd:ui-review`, `/gsd:eval-review`, `/gsd:ship`, `/gsd:extract-learnings` and `/gsd:review` now use the phase you pass them** — all seven read `${PHASE_ARG}` without ever deriving it, so the phase argument was discarded on every run: `init.phase-op` resolved `phase_found:false` unconditionally and each command exited reporting that a blank phase had not been executed. Each workflow now derives the value before the read, using the grammar its own argument-hint documents, and a new `lint-phase-arg-assignment` gate fails any workflow that reads the variable without a canonical assignment or a prose derivation step. (#4777)
