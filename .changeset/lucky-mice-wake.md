---
type: Fixed
pr: 0
---
**The decision-coverage gate no longer fails open on unrecognized decision-ID prefixes** — `check.decision-coverage-plan` classified a populated `<decisions>` block as "no trackable decisions" (a clean pass) whenever its IDs used a prefix the parser couldn't read (e.g. `D5-01` instead of `D-01`), silently skipping the gate on real decisions. The gate now recognizes any bold-lead-in decision bullet as evidence and fails loud (`could-not-parse`) when it can't read a populated block, instead of passing. (#2347)
