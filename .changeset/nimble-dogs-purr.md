---
type: Fixed
pr: 709
---
**Worktree wave-cleanup no longer fails when the phase SUMMARY is committed** — `rescueSummaryArtifacts` no longer copies an already-committed SUMMARY into the main checkout, which previously caused `git merge --no-ff` to abort with a permanent `merge_failed` (#706).
