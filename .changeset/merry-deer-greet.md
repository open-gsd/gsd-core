---
type: Added
pr: 722
---
**`/gsd-capture --list-seeds` audits parked seeds** — a new read-only listing of `.planning/seeds/` showing each seed's ID, status, scope, and trigger, with an optional status filter (e.g. `--list-seeds dormant`). Backed by the `gsd-tools list-seeds` command. Previously seeds could only be created or auto-surfaced at `/gsd-new-milestone`, with no way to browse them on demand (#441).
