---
type: Fixed
pr: 2248
---
**`phase complete` now reads milestone-grouped ROADMAP progress tables** — progress reported 0% on projects whose Progress table carries a Milestone column, because the reader assumed a fixed column position; it now resolves progress columns by name so both flat and milestone-grouped tables work (#2137). Quick Tasks logging via `/gsd:fast` also appends schema-correct, lock-safe rows instead of guessing the column count in shell (#2133). (#2248)
