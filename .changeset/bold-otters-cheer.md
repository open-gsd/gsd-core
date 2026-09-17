---
type: Fixed
pr: 0
---
**verify-work stops flagging honest plans as commit_claim_mismatch** — the reconciliation measured `plan_head_before..HEAD`, a window that grows with every later plan's commits and the phase-completion commit, so any plan except the last read as a BLOCKER. The executor now records `plan_head_after` (HEAD at its measurement moment) and verify-work reconciles against that bounded window with exact equality; legacy SUMMARYs without the anchor fall back to a warning, and the #3968 failure modes still block. (#4670)

<!-- #4670 un-established edges, per the issue: parallel worktree waves sharing a base and multi-repo commit-to-subrepo ledgers are not covered by the bounded window; the window strictly narrows relative to the previous check. -->
