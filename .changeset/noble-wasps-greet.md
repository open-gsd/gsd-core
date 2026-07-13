---
type: Fixed
pr: 2234
---
**`phase complete` no longer false-reports REQ-IDs as missing when the traceability table leads with a status column** — the parser required the REQ-ID in the first column, so a table shaped `| ☐ | REQ-01 | …` matched zero rows and every body REQ-ID was reported missing. It now matches REQ-IDs in any column. (#2203)
