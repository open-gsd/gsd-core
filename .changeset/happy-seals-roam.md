---
type: Fixed
pr: 2214
---
**`/gsd-fast` now appends Quick Task rows to STATE.md again** — the log_to_state column-count guard used an off-by-one awk formula (`NF-1`) that was always one too high, so the schema gate rejected the very table quick.md creates and silently skipped the STATE.md update. Also now supports the 6-column validate-mode table. (#2133)
