---
type: Fixed
pr: 5686
---
**`state begin-phase` no longer leaves an untracked `.planning/milestone.lock` that blocks `/gsd-ship`** — the per-machine milestone claim is now excluded through the repo-local `.git/info/exclude`, so `git status` stays clean apart from STATE.md. A tracked copy is left alone. (#5551)
