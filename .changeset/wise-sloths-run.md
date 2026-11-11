---
type: Fixed
pr: 5995
---
**Planning no longer commits cross-plan threat-ID collisions** — Rescan threat registers after planner passes and before commits, returning duplicate IDs as revision blockers, and require unique IDs for cross-plan threat references (#5995).
