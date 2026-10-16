---
type: Fixed
pr: 5452
---
`roadmap update-plan-progress` now drops completed plans from a trailing `pending (…)` list on the Plans line, replaces a bare `**Plans**: TBD` with the count, and returns a `warnings` entry when a word-prefixed `Phase N` Progress row is not updated (#4947)
