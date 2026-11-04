---
type: Added
pr: 0
---
**STATE.md size warnings** — `quick-tasks-append` now reports a `warnings` entry (exit 0, row still written in full) when a task description is over 240 characters, and `/gsd-health` adds the advisory warning `W031` when STATE.md is more than 3x its 100-line target, pointing to `state prune` and `/gsd-cleanup`. `/gsd-quick` and `/gsd-fast` pass a one-line title, and the STATE.md line target now reads 100 everywhere (#5830).
