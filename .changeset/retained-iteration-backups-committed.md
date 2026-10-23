---
type: Fixed
pr: 5454
---
**`code-review-fix --auto` no longer leaves retained iteration backups uncommitted** — when a run ends non-clean and `commit_docs` is on, the `.iterN.md` backups are now committed, so they no longer leave the working tree dirty (`/gsd-ship` no longer refuses on them) and the post-mortem trail stays recoverable. A per-phase `phase_commit_docs` override of `false` still skips the commit; the step then warns that the backups were not committed (#5506).
