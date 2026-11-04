---
type: Added
pr: 5487
---
**`git.commit_timeout_ms` config key** — set the SDK git commit timeout (integer ms, 1 to 3600000, default 30000) so a slow pre-commit hook has longer to finish before the commit is killed; an invalid hand-edited value falls back to the default.
