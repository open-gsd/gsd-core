---
type: Fixed
pr: 5436
---
verify plan-structure now fails a truncated PLAN.md (leftover write sentinel, unclosed <tasks>, or a file ending mid-tag); the planner and checker run count/match acceptance gates against the current tree and record a baseline; and the planner and its reversibility reference agree that an already-settled one-way decision gets no new checkpoint.
