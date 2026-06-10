---
type: Fixed
pr: 989
---
**`gsd-planner` now ships the `Edit` tool, so it can no longer destroy `ROADMAP.md` via a whole-file `Write`** — the planner had `Write` but not `Edit` (the #571/#581 writer-agent gap), so an in-place ROADMAP edit fell back to a full overwrite that truncated committed milestone history. The `update_roadmap` step now directs scoped `Edit` calls and explicitly forbids passing the full file to `Write`. (#973)
