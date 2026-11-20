---
type: Fixed
pr: 0
---
**Installing a capability from a Git source no longer leaves its scratch clone behind silently when removing it fails once** — the clone's temporary directory was removed in a single `rmSync` attempt whose failure was swallowed, so a writer still under it (a detached `git gc --auto`, an external scanner: `ENOTEMPTY`, `EBUSY`) left the clone on disk with nothing reported. Git is now told not to start automatic maintenance in the throwaway clone, the removal retries the way the clone's `.git` removal in the same function does, and a removal that still fails emits a `GSD_SCRATCH_CLONE_LEFT` warning naming the directory. (#6441)
