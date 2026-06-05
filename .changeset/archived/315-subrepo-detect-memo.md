---
type: Fixed
pr: 315
---
`loadConfig` now memoizes `detectSubRepos(cwd)` per call, collapsing up to 3 redundant directory scans into 1 when migrations and filesystem re-sync both trigger.
