---
type: Fixed
pr: 0
---
**ROADMAP Progress-table writes now edit the table the readers read** — `phase remove`, `phase complete`, `roadmap update-plan-progress` and `phase add` pick the Progress section through the same owner as every reader, so a fenced `## Progress` example no longer captures a write while the real table keeps the stale row, and `drift-guard phase-status` accepts a `## Progress Tracker` heading like the other readers. (#5762)
