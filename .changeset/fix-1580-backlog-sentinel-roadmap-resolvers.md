---
type: Fixed
pr: 1612
---
**Milestone and roadmap progress now ignore Phase 0 and 999 sentinel phases** - `milestone complete`, `roadmap analyze`, `state` progress, and roadmap progress-table counters no longer treat pre-milestone setup or backlog sentinel rows as executable phases, while decimal real phases such as `00.1` and canonical large phases such as `1000` still count normally. (#1612)
