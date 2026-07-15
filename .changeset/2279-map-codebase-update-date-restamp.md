---
type: Fixed
pr: 2303
---
`map-codebase` update runs now restamp the codebase-doc dates (Analysis Date, the analysis/audit footer, and the `<!-- refreshed -->` header) to the current date instead of preserving the previous run's date. Previously the agent only substituted the `[YYYY-MM-DD]` placeholder, which is absent once a document already carries a concrete date, so Update runs left every stamp stale. (#2279)
