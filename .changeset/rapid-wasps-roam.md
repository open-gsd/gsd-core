---
type: Fixed
pr: 0
---
**A config file that is a named pipe or device no longer hangs gsd-tools** — a FIFO at .planning/config.json or a workstream config.json blocked every command that reads configuration; each read is now bounded, the command continues without that file (a workstream falls back to the root config), a config.json over 1 MiB is refused, and temporary files are created exclusively without following links. (#5759)
