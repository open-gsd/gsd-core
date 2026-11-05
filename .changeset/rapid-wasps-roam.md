---
type: Fixed
pr: 0
---
**A config file that is a named pipe or device no longer hangs gsd-tools** — a FIFO at .planning/config.json or a workstream config.json blocked resolve-model and every command that loads configuration; it is now reported as unreadable and defaults apply. (#5759)
