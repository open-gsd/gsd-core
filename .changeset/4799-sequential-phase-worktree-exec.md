---
type: Fixed
pr: 4951
---
**Sequential phase runs inside a linked git worktree can commit on their phase branch again** — In a linked worktree, running a phase or plan sequentially previously failed with an error refusing commits to non-agent phase branches, and skipped local state tracking. Sequential execution now respects the negotiated sequential mode, allowing normal commits to phase branches while continuing to isolate parallel wave executions.
