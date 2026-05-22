---
type: Fixed
pr: 80
---
`find-phase` now searches milestone archive directories in ascending version order (`v1.2-phases` before `v1.10-phases`) rather than descending order, making archive traversal deterministic and consistent with numeric version semantics. (#3816)
