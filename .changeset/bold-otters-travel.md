---
type: Fixed
pr: 1177
---
**`phase complete` no longer rewrites an existing roadmap completion date** — repeat runs on an already-`Complete` phase preserve the recorded `YYYY-MM-DD` date (4- and 5-column layouts); empty/`-`/non-date cells are still stamped with the current date.
