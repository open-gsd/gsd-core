---
type: Fixed
pr: 2303
---
**`map-codebase` Update runs now restamp the codebase-doc dates (Analysis Date, the analysis/audit footer, and the `<!-- refreshed -->` header) to the current date** — previously the agent only substituted the `[YYYY-MM-DD]` placeholder, which is absent once a document already carries a concrete date, so Update runs preserved the previous run's stale date in every stamp. (#2279)
