---
type: Fixed
pr: 4766
---
**`worktree cleanup-wave` no longer kills an executor merge at the 10-second git plumbing timeout while a `pre-merge-commit` hook runs** — the merge step now carries its own 10-minute budget (`deps.mergeTimeoutMs`), a merge that does exceed it blocks on a distinct `merge_timed_out` reason naming the budget instead of a `merge_failed` carrying the hook's partial output, and the staged-but-no-`MERGE_HEAD` index a killed merge leaves in the primary checkout is detected and restored with `git reset --merge` (reported per path as `merge_residue_restored`; `merge_residue_left_staged` halts the wave when it cannot be), so committing from the primary after a killed merge no longer squashes the executor's history. (#4721)
