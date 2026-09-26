---
type: Fixed
pr: 5003
---
**`verification.status` no longer tells you to re-execute a phase whose directory is not there** — a path that does not exist or is not a directory (most often a stale phase path after complete-milestone archived the phase) was answered as status `missing`, routed to `/gsd-execute-phase`, even for a phase verified `passed`. It now reads `phase_dir_not_found`, names the resolved path, and routes nowhere; `verification.resolve-file` gains a `phase_dir_found` field so an absent directory is no longer indistinguishable from one that holds no report. A directory that exists with no report still reads `missing`. (#4987)
