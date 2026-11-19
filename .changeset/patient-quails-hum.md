---
type: Fixed
pr: 6313
---
**`validate health --ws` checks and repairs the workstream's own milestone archive** — W018 and its `--repair` backfill compared and wrote the root `MILESTONES.md`/`milestones/` even though `milestone complete --ws` archives into the workstream, so repairing one workstream edited the shared root file and the workstream's own archive was never checked; both now use the same project/workstream-scoped pair. (#5881)
