---
type: Fixed
pr: 0
---
**`/gsd:resume-work` no longer announces a handoff it did not claim** — the claim step now checks that the claimed file is there before printing `HANDOFF_FILE=`, so a session that loses a claim race is told `NO_UNCLAIMED_HANDOFF` instead of exiting 1 when its `mv` reported success on Windows without leaving a file. (#6873)
