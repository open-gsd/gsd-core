---
type: Fixed
pr: 5454
---
**`code-review-fix --auto` no longer leaves retained iteration backups uncommitted** — a run that ends non-clean with `commit_docs` on now commits its `.iterN.md` backups, so they no longer leave the working tree dirty (`/gsd-ship` no longer refuses on them) and the post-mortem trail is recoverable from git; a later converged run deletes its backups and, with `commit_docs` on, commits the removal of backups that an earlier run committed, so that tree stays clean too; both the cleanup and the disposition steps now treat only `.iter<digits>.md` names as backups, so a file such as `.iter2-notes.md` is left alone and no longer counts as a fix report for the disposition step (#5506).
