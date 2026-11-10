---
type: Fixed
pr: 5424
---
**`state planned-phase --plans` exits non-zero and writes nothing when it cannot record the count** — it used to exit 0 for a STATE.md with no plan line, for a count below the recorded plan position, for `Plan:` and `Current Plan:` lines that record different positions, and for a recorded position above 9007199254740991 (those three on a same-phase replan), and for an invalid value (`3.5`, `3abc`, `-1`).
