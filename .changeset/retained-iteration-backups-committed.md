---
type: Fixed
pr: 5454
---
**`code-review-fix --auto` no longer leaves retained iteration backups uncommitted** — a run that ends non-clean with `commit_docs` on now commits its `.iterN.md` backups, so they no longer leave the working tree dirty (`/gsd-ship` no longer refuses on them) and the post-mortem trail is recoverable from git; a converged run still deletes its backups and commits nothing (#5506).
