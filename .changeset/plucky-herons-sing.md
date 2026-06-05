---
type: Fixed
pr: 643
---
**Wave-cleanup no longer refuses merge-back for an orchestrator running from a non-primary worktree** — the two `execute-phase` wave-cleanup guards now pin to the dispatch-time orchestrator root persisted in `WAVE_WORKTREE_MANIFEST`, instead of `git worktree list`'s first entry (always the main checkout). A per-phase-lane orchestrator with `workflow.use_worktrees: true` is no longer cd'd off its own branch into the #3174 branch-drift assertion at cleanup. Byte-identical for a primary-worktree orchestrator. Follow-up to #590.
