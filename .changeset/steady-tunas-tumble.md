---
type: Fixed
pr: 4681
---
**Parallel ledger writers no longer silently lose windows entries** — two concurrent `gsd_run windows append` (or waive/fixed) invocations both reported success while one entry vanished from `WINDOWS.md`, false-greening the /gsd-ship gate; the mutating commands now serialize on a cross-process ledger lock and refuse with a typed `windows_ledger_lock` error only when a live writer holds it past the retry budget. (#3780)
