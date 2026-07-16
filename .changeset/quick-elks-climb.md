---
type: Fixed
pr: 2317
---
**`audit-uat` no longer reports a false-clean `total_items: 0` when real items exist** — the parsers ignored two artifact shapes: a `## Gaps` section recording open findings, and verification items declared in frontmatter (`human_verification:` array) or as `### N.`+bold-paragraph blocks. audit-uat now surfaces unresolved `## Gaps` entries and reads the frontmatter array / heading shape, so a phase with outstanding UAT/verification work is no longer waved through as clean. (#2286)
