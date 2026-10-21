---
type: Fixed
pr: 5393
---
**Decision-coverage gates count decisions cited in tracker-held task bodies (#5317)** — `check decision-coverage-plan` and `check decision-coverage-verify` now resolve `tracker-id` tasks through the task-content resolution seam, so a decision cited only in a body that an external tracker holds (e.g. beads `sync_mode=authoritative`) is no longer reported uncovered. A resolver that fails, times out or returns ambiguous or malformed output, a `tracker-id` with an unsafe id (leading `-` or control characters), a registry that cannot load, or an exhausted aggregate resolution budget blocks the plan gate (verify reports unreadable); a tracker prefix with no installed resolver does the same when a decision would otherwise be uncovered; plans without `tracker-id` behave as before. `task resolve-content` likewise now exits non-zero on an unsafe `tracker-id` before any resolver is spawned.
