---
type: Fixed
pr: 5424
---
**`state planned-phase --plans` records the count on the `Plan:` line and resets the position on a new phase** — a bare `Plan: N` stayed without a total, `0 TBD in current phase` stayed as written, a replan for a new phase kept the old position, and `--plans 0` printed `? plans ready`; the line now reads `N of M`, a new phase starts at `0 of M in current phase`, and `--plans 0` prints `0 plans ready`.
