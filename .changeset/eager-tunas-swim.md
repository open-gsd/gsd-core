---
type: Fixed
pr: 1991
---
**`/gsd-quick` no longer halts with a stale-base worktree mismatch** — the worktree executor now degrades to sequential execution when its fork base has diverged from origin/HEAD, instead of spawning a worktree guaranteed to fail the base-mismatch guard.
