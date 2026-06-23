---
type: Fixed
pr: 1543
---
A failed `roadmap upgrade --apply` now actually rolls back .planning/ even when it is gitignored (commit_docs:false), instead of reporting a successful rollback while leaving the workspace half-migrated. Rollback is surgical and no longer runs a whole-repo git reset --hard.
