---
type: Fixed
pr: 5424
---
**`state planned-phase --plans` exits non-zero and writes nothing when it cannot record the count** — it used to exit 0 for a STATE.md with no `Plan:` or `Current Plan:` line and no `Total Plans in Phase:` line, for a `Plan:` value, or a `Current Plan:` value with no `Total Plans in Phase:` line, that reads `N of` with no total (`2 of 5.5`, `2 of 5a`), for a `Plan:` or `Current Plan:` line that sits only in the frontmatter, for a count below the recorded plan position, for `Plan:` and `Current Plan:` lines that record different positions, and for a recorded position above 9007199254740991 (those three on a same-phase replan), and for an invalid value (`3.5`, `3abc`, `-1`).
