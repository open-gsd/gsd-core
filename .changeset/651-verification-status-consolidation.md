---
type: Changed
pr: 755
---
**Verification status routing is now owned by a single queryable seam** — `ship.md` and `execute-phase.md` both consume `gsd_run query verification.status` instead of re-deriving the `passed`/`gaps_found`/`human_needed` routing independently; the query returns `next_action` and `next_command` so per-status prose no longer needs to be kept in sync across files. This also fixes the broad-grep status misread in `execute-phase.md` where a body `status:` line (in a code block or copied artifact) could concatenate with the frontmatter value and misroute a valid passed phase; a parity test fails if a new verifier status value lacks a route. (#651)
