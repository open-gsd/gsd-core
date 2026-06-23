---
type: Fixed
pr: 1612
---
**Milestone and roadmap progress now ignore Phase 0 and 999 sentinel phases** - `milestone complete`, `roadmap analyze`, `state` progress, and roadmap progress-table counters no longer treat pre-milestone setup or backlog sentinel rows as executable phases, while decimal real phases such as `00.1` and canonical large phases such as `1000` still count normally. (#1612)

When `ROADMAP.md` is missing, fallback milestone phase scans now also exclude Phase 0 and 999 sentinel directories such as `00-bootstrap` and `999-backlog`.
