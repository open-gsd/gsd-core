---
type: Fixed
pr: 5799
---
**ROADMAP Progress-table writes now edit the table the readers read** — `phase remove`, `phase complete`, `roadmap update-plan-progress` and `phase add` pick the Progress section through the same owner as every reader, so a fenced `## Progress` example no longer captures a write while the real table keeps the stale row, a fenced `#` line no longer cuts the writable section short, an indented or bare `##` line now ends it as it does for the readers, and `drift-guard phase-status` accepts a `## Progress Tracker` heading like the other readers. (#5762)
