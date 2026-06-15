---
type: Fixed
pr: 1236
---
**state record-session no longer pins a CPU core forever** — acquireStateLock busy-spun at 100% CPU when a recoverable errno (e.g. ENOENT from a removed worktree) persisted, because that retry path skipped the backoff sleep and the 30s time budget. Every retry path is now bounded and backed off. (#1236)
