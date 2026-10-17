---
type: Fixed
pr: 5434
---
gsd-tools no longer probes its own process start-time (a PowerShell launch on Windows, a `ps` on macOS) on every config read; capability-lock now probes on its first lock acquire and caches only a successful result, retrying once if that probe fails (#5327).
