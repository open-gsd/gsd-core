---
type: Fixed
pr: 951
---
**`audit-open` no longer false-flags completed quick tasks** — quick-task SUMMARYs now carry `status: complete` in frontmatter by construction, so the milestone-close auditor stops reporting finished quick tasks as `[unknown]`.
