---
type: Fixed
pr: 5424
---
**`state planned-phase --plans` records the count on the `Plan:` line and resets the position on a new phase** — a bare `Plan: N` stayed without a total. `0 TBD in current phase` stayed as written. A replan for a new phase kept the old position. `--plans 0` printed `? plans ready`. The line now reads `N of M`, and a new phase starts at `0 of M in current phase`. `--plans 0` prints `0 plans ready`.
