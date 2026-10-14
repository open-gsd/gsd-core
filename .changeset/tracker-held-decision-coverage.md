---
type: Fixed
pr: 45
---
**Decision-coverage gates count decisions cited in tracker-held task bodies (#5317)** — `check decision-coverage-plan` and `check decision-coverage-verify` now resolve `tracker-id` tasks through the task-content resolution seam, so a decision cited only in a body that an external tracker holds (e.g. beads `sync_mode=authoritative`) is no longer reported uncovered. A resolver that fails, times out or returns ambiguous or malformed output blocks the plan gate (verify reports unreadable); plans without `tracker-id` behave as before.
