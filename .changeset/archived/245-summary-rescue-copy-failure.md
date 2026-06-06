---
type: Fixed
pr: 616
---
**`worktree.cleanup-wave` no longer silently loses a SUMMARY.md when the rescue copy fails** — a failed `*SUMMARY.md` rescue now blocks cleanup with `summary_rescue_failed` instead of merging and removing the worktree, preventing silent data loss.
