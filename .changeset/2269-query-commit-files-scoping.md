---
type: Fixed
pr: 0
---
**`secure-phase`, `validate-phase`, and `next` workflows now scope their `query commit` calls** — all three pass `--files` with the specific artifact path, preventing the blanket `git add .planning/` default branch from sweeping unrelated staged or unstaged files into a commit whose message describes a single artifact. Previously, these three call sites (out of 65 total) were the only ones omitting `--files`, causing #2112's commit-scoping fix to never reach them. (#2269)
