---
type: Fixed
pr: 0
---
**Installing a capability from a Git source no longer leaves its scratch clone behind when removing it fails once** — the clone's temporary directory was removed in a single `rmSync` attempt whose failure was swallowed, so a git process still writing under it (`ENOTEMPTY`, `EBUSY`) left the clone on disk with nothing reported. The removal now retries the way the clone's `.git` removal in the same function already did. (#6441)
