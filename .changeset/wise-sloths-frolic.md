---
type: Added
pr: 0
---
**`/gsd-debug list` and `/gsd-debug status <slug>` now run on Pi** — the Pi skill printed "unsupported" for every form of `/gsd-debug`, including the two that start no agent. They now read `.planning/debug/` and print the session table or one session; `new`, `continue` and `--diagnose` still print that they need nested dispatch. (#5630)
