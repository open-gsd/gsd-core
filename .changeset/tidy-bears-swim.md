---
type: Fixed
pr: 0
---
**`requirements mark-complete` and `phase complete` now advance a traceability row whose Status carries a note** — a cell such as `Pending (blocked on an upstream decision)` was refused, so `mark-complete` rolled the checkbox back and reported the requirement `not_found` although its checkbox and row both existed, and `phase complete` skipped the row silently while still reporting an update. Both commands now read the status word at the start of the cell (the rule the ROADMAP Status reader already uses), so the annotated row reaches `Complete`; `Blocked`, `Deferred`, `Completed` and a word glued onto the status (`Pendingx`) are still refused. (#6238)
