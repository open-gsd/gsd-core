---
type: Fixed
pr: 4538
---
**`commit --files` now reports which explicitly-named paths were skipped** — a path named in `--files` that no longer exists on disk was silently dropped from the commit (guarding against staging an unwanted deletion), but the result reported unqualified success with no way to tell a partial commit from a complete one. The result now includes `skipped_files` naming any dropped path, present only when something was actually skipped. (#4454)
