---
type: Fixed
pr: 0
---
**`/gsd-audit-uat` no longer reports `All Clear` for an audit that scanned no files** — the all-clear fired whenever there were no items and no parse gaps, and `total_files` counts only files that held something to report, so a tree the scan never reached read the same as a tree of clean files; `audit-fix` could likewise report zero findings from a tree it never walked. `audit-uat` now reports `summary.files_scanned` (every UAT, VERIFICATION and deferred-items file it read), `/gsd-audit-uat` and `/gsd-audit-fix` print `Nothing Scanned` when it is 0, and a clean audit prints how many files it scanned. (#6231)
