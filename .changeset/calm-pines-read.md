---
type: Fixed
pr: 5424
---
**`state advance-plan` and the `init` plan-count check read a plan total followed by punctuation, and the word `of` in any letter case** — `Plan: 2 of 5.` and `Plan: 2 of 5)` were refused by `advance-plan` and gave `init` no total. `Plan: 2 OF 5` was not read either. All three now read a total of 5.
