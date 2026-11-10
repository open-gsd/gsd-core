---
type: Fixed
pr: 5424
---
**`state planned-phase --plans` exits non-zero and writes nothing when it cannot record the count** — a STATE.md with no `Plan:`, `Current Plan:` or `Total Plans in Phase:` line, a count below the recorded plan position, or an invalid value (`3.5`, `3abc`, `-1`) used to exit 0, and a bare `Status: Ready` becomes `Ready to execute`.
