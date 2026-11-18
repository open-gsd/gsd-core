---
type: Added
pr: 5882
---
**STATE.md size warnings** — `quick-tasks-append` now reports a `warnings` entry (exit 0, row still written in full) when a task description is over 240 characters (`quick-batch complete` returns the same `warnings` for the row it appends), and `/gsd-health` adds the advisory warning `W031` when STATE.md is more than 3x its 100-line target, pointing to `state prune` and `milestone archive-quick`. `/gsd-quick` and `/gsd-fast` pass a one-line title, and the STATE.md line target now reads 100 everywhere (#5830).
