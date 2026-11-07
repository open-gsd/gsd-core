---
type: Fixed
pr: 5550
---
**`commit --files` skips an ignored, untracked `state.json` instead of failing** — naming the derived file made the whole commit abort with `staging_failed`; it now lands in `skipped_files` and the other files still commit. (#5505)
