---
type: Fixed
pr: 1541
---
Atomic file writes now retry a transient rename lock on Windows (a reader holding the target open) instead of falling back to a non-atomic write that could let a concurrent reader observe a truncated STATE.md/ROADMAP.md.
