---
type: Fixed
pr: 6371
---
**The isolation guard no longer tells the orchestrator to add the harness flag when a recorded degrade refused it** — a flag-less executor dispatch blocked after a base-check or recorded `none` degrade was told to add `isolation="worktree"`, the very action the degrade had refused; the deny now names the recorded degrade and how to record a decision for the dispatch, for the Claude guard and the Cursor hook alike, while the block decision and reason code are unchanged. (#6028)
