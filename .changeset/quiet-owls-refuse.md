---
type: Fixed
pr: 5424
---
**`state planned-phase --plans` exits non-zero and writes nothing when it cannot record the count** — it used to exit 0 and report success. It now refuses a STATE.md with no `Plan:`, `Current Plan:` or `Total Plans in Phase:` line. It refuses a plan line that sits only in the frontmatter. It refuses a `Plan:` value that reads `N of` with no total (`2 of 5.5`, `2 of 5a`), and the same for a `Current Plan:` value with no `Total Plans in Phase:` line. It refuses a digit-led value that reads no position (`Plan: 3/5`) when no `Total Plans in Phase:` line can hold the count. On a same-phase replan it also refuses a count below the recorded plan position, `Plan:` and `Current Plan:` lines that record different positions, and a recorded position above 9007199254740991. It refuses an invalid `--plans` value (`3.5`, `3abc`, `-1`).
