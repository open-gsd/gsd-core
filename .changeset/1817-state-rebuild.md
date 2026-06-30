---
type: Added
pr: 1830
---
**`gsd-tools state rebuild`** — new subcommand that re-derives STATE.md body structure from canonical sources (frontmatter + `.planning/phases/` disk scan), reconciling drifted `## Current Position` prose, dropping orphaned rows from the `**By Phase:**` table, clearing template-placeholder field values, and de-duplicating `## Session Continuity Archive` blocks. Every mutation is recorded in a `## Rebuild Log` audit section. Idempotent (running twice on a clean file is a no-op). Supports `--dry-run` (preview) and `--verbose` (tee log to stderr). Heavier, manual counterpart to the lightweight auto-triggered `state sync`.
