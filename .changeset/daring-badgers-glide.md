---
type: Fixed
pr: 4744
---
**`/gsd-code-review`, `/gsd-code-review-fix`, `gsd-code-fixer`, `/gsd-execute-plan` and `/gsd-plan-phase` now accept letter-variant phase ids (`12A`, `3A`, `23A.1.2`)** — the six shell/markdown phase-number mirrors #4568 widened on the segment-count axis were still digit-only on the letter axis, so a documented, canonical-valid id like `12A` was refused with "Invalid phase number format" by the four validating sites and silently truncated to its digit prefix by the two extracting ones. All six now match the canonical grammar (`src/phase-id.cts`), a parity test proves both sides agree on the letter axis in both directions, and `lint-phase-id-drift` gains a ratchet so a digit-only mirror cannot re-diverge silently. (#4660)
