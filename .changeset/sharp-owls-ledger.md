---
type: Fixed
pr: 5587
---
**A ledger counts mismatch now names the rows the table and the JSON block disagree about** — a table-only `WINDOWS.md` row with the frontmatter counts bumped to match used to fail with only "Ledger counts disagree with entries", pointing at the correct frontmatter. The same `windows_ledger_malformed` error now lists the row ids present in the table but absent from the fenced JSON block (and the reverse) and says the JSON block is the authoritative source. (#5418)
