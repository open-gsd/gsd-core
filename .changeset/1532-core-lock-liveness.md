---
type: Fixed
pr: 1532
---
**Core-path file locks now verify the holder process is alive before stealing a stale lock (#1532)** — the STATE.md write lock (`acquireStateLock`) and the `.planning/` workspace lock (`withPlanningLock`) previously stole locks on a bare `mtime` timer with no liveness check, so a live-but-slow holder (e.g. a deep `.planning/` scan on slow NFS) could have its lock stolen mid-write, corrupting STATE.md or losing an update. Both locks now gate stealing on `process.kill(pid,0)` liveness with a deadman ceiling above the wait budget (pid-reuse backstop), `withPlanningLock` no longer force-steals a live holder on timeout (and can no longer leak an uncaught `EEXIST`), `writeStateMd` computes its disk scan inside the lock, and `acquireStateLock` no longer leaks a file descriptor or strands an empty lock on a recoverable write error. The uncontended path is unchanged.
