---
type: Fixed
pr: 6025
---
**Ghost REQ-ID warning no longer fires on registered requirements** — `phase complete` warned "not registered anywhere" for a requirement whose checkbox used a mark other than space or x (such as `[~]`) or whose Traceability table has no Status column, and `requirements mark-complete` reported the same row as `table_unmatched`; both now see the row, and a row in a table without a Status column gets its own write-skipped message. (#5844)
