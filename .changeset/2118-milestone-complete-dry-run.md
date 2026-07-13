---
type: Fixed
pr: 2155
---
**`milestone complete --dry-run` now prints a preview plan instead of silently mutating** — `gsd-tools milestone complete --dry-run` was neither parsed nor rejected, so a caller expecting a preview triggered the full destructive mutation (archive phases, move audit artifacts, rewrite STATE.md) with no way to back out. The `--dry-run` flag is now honored: it returns a JSON plan listing `would_archive` (roadmap, requirements, audit, phase dirs) and `would_update` (MILESTONES.md, STATE.md) targets with zero filesystem mutations. (#2118)
