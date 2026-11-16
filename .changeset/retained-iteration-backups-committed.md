---
type: Fixed
pr: 5454
---
**`code-review-fix --auto` no longer leaves retained iteration backups uncommitted** — a non-clean run with `commit_docs` on now commits its `.iterN.md` backups. The working tree stays clean, so `/gsd-ship` no longer refuses on them. A later converged run deletes its backups. With `commit_docs` on, it also commits the removal of backups that an earlier run committed. The cleanup and disposition steps treat only `.iter<digits>.md` names as backups. A file such as `.iter2-notes.md` is left alone and no longer counts as a fix report (#5506).
