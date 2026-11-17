---
type: Fixed
pr: 0
---
**`record-dispatch-isolation` no longer hangs when `.gsd/.gitignore` is a FIFO** — the ignore file is now opened without blocking, so a non-regular ignore file is skipped and the isolation sentinel is still recorded. (#5857)
