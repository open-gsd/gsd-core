---
type: Fixed
pr: 986
---
**`graphify query --budget` with no value now errors instead of silently ignoring the budget** — a trailing `--budget` parsed as `NaN` and was treated as 'no budget', so the query ran unbounded with no warning. (#974)
