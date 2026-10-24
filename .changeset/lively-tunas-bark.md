---
type: Fixed
pr: 5669
---
**`state.planned-phase` no longer writes a progress block whose percent contradicts its counters** — the completed-count ratchet now compares numerically (frontmatter values are strings, so a larger on-disk count was always ignored), and `percent` is recomputed over the counters actually written, so a stored 1/2 phases and 1/2 plans can no longer be written at 0%. (#5619)
