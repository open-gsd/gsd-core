---
type: Fixed
pr: 0
---
**`parseCoverageMatrix` now scopes table parsing to recognized coverage matrices** — pipe-tables outside the matrix (e.g., summary tables) are ignored instead of being silently parsed as data rows, multi-section matrices with repeated headers are supported, and inline markdown emphasis (`**OPT-OUT**`) on decision cells is stripped before validation. Previously, the parser scanned every `|`-prefixed line file-wide with a latching header flag, causing silent phantom-capability corruption from unrelated tables, false rejection of multi-section matrices, and rejection of bold-emphasized decisions. (#2366)
