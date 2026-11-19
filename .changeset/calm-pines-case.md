---
type: Fixed
pr: 5424
---
**`state advance-plan` and the `init` plan-count check read the word `of` in any letter case** — `Plan: 2 OF 5` was refused by `advance-plan` and gave `init` no total. It now reads a total of 5.
