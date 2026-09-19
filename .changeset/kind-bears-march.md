---
type: Fixed
pr: 0
---
**Harness-worktree waves no longer degrade to sequential on a stale origin/HEAD when the fork base is confirmed from a prior worktree** — the worktree base-check now observes the harness's actual fork behavior from a clean prior harness worktree at the orchestrator HEAD before degrading; every unobservable case still degrades exactly as before. (#4588)
