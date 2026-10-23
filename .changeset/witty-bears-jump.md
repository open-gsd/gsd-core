---
type: Fixed
pr: 5455
---
TDD review checkpoint accepts a `fix(<phase>-<plan>)` commit as the GREEN step, not only `feat`, and the TDD reference, planner, and executor docs state one rule: `feat` for new behaviour, `fix` when the plan corrects a defect. (#5274)
