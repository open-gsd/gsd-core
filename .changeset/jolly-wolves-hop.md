---
type: Fixed
pr: 465
---
**`phase complete` no longer leaves roadmap and state inconsistent after a failed state publish** — phase completion now publishes planning files from one locked transaction and rolls back earlier writes when a later write fails.
