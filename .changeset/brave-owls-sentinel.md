---
type: Fixed
pr: 5597
---
**A recorded sequential isolation degrade keeps governing its phase after the sentinel's trust window** — the isolation guard (and the Cursor subagent-start hook) forgot a `none` decision once the previous executor had run longer than the 10-minute window, then answered from the host capability and denied the next flag-less executor dispatch of the same phase (#4317 recurring). A `none` recorded for the dispatch's own phase now still applies when aged, in both hooks through one shared predicate; it never applies to another phase, a dispatch whose phase cannot be established, an aged `harness-worktree` record or a future-dated record. The per-plan worktree gate also no longer re-persists `harness-worktree` over a recorded degrade when its plan state was lost with an earlier tool call's shell. (#5479)
