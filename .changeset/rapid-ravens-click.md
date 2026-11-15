---
type: Added
pr: 5487
---
**`git.commit_timeout_ms` config key** — a pre-commit hook that ran longer than 30 s was killed mid-commit, and the bound could not change; set the key (integer ms, 1 to 3600000, default 30000) to give a slow hook longer, and an invalid hand-edited value falls back to the default (#5231).
