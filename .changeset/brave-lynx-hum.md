---
type: Fixed
pr: 4508
---
**The Conventional Commit hook no longer exits with SIGPIPE on large custom commit-type lists** — it now preserves its documented allow/block exit contract regardless of payload size.
