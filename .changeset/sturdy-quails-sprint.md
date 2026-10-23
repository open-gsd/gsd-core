---
type: Fixed
pr: 5641
---
**In a multi-plan wave each executor is now dispatched against its own isolation record** — `/gsd-execute-phase` recorded every plan's dispatch-isolation sentinel up front, so the single slot held only the last plan and the isolation guard denied earlier plans' sequential dispatches. Each plan's worktree decision is still made for the whole wave first, but the record is now written immediately before that plan's dispatch. (#5516)
