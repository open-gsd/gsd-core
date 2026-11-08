---
type: Fixed
pr: 5190
---
**`gsd-plan-checker` no longer calls queries the runtime does not register.** It guards research and summary file scans against an unset phase directory, reads task structure and displays its verdict from `verify.plan-structure`, and uses `frontmatter.get --field` with JSON error checks. (#5178)

**`/gsd-thread` and `/gsd-quick` read saved status correctly when listing threads and quick-task history.** Their status queries, and the quick-batch planner's reads of each plan's `depends_on` and `files_modified`, now use the required named-field argument. (#5178)
