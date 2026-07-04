---
type: Fixed
pr: 1917
---
**`milestone complete --ws` now archives into the workstream instead of root** — the archive paths (MILESTONES.md, the milestones/ archive dir, and the per-version MILESTONE-AUDIT.md) were hardcoded to root `.planning/`, so a workstream milestone close scattered its artifacts into root and never produced a workstream-local archive. They now derive from the workstream-aware planning base (`planningPaths(cwd).planning`); flat-mode (no --ws) is unchanged. (#1911)
