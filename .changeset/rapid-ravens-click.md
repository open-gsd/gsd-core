---
type: Added
pr: 5487
---
**`git.commit_timeout_ms` config key** — set the SDK git commit timeout (integer ms, 1 to 3600000, default 30000) so slow pre-commit hooks no longer kill commits; an out-of-range hand-edited value falls back to the default.
