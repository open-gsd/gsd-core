---
type: Fixed
pr: 6290
---
**`state record-session` and `state add-decision` no longer zero `progress.total_plans` after a milestone close** — when `.planning/phases/` exists but is empty (the shape `milestone complete` leaves), the stored plan counters are kept, the same as when the directory is absent. (#6279)
