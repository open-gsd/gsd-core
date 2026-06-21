---
type: Fixed
pr: 1550
---
**Workflow temp files now randomize correctly on BSD/macOS** — several workflows called `mktemp` with templates where `XXXXXX` was followed by a `.json`/`.md` suffix (e.g. `gsd-worktree-wave-XXXXXX.json`, `gsd-pr-body.XXXXXX.md`). BSD/macOS `mktemp` only substitutes `XXXXXX` when it is the final path component, so those templates returned a literal, non-randomized path, letting concurrent workflow runs collide on the same temp manifest/body file (one run overwriting or consuming another's). The fix creates a suffixless temp then renames to add the extension — portable across BSD + GNU. Affected: `execute-phase`, `quick`, `spec-phase`, `ship`, `profile-user`. (#1520)
