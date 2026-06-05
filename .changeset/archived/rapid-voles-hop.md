---
type: Fixed
pr: 634
---
**`/gsd-graphify build` no longer fails when the graph is too large for an HTML visualization** — when a graph exceeds graphify's HTML viz node limit (default 5000) the `graph.html` artifact is intentionally skipped; the build pipeline now tolerates its absence instead of aborting, so `graph.json`, `GRAPH_REPORT.md`, the diff snapshot, and the status report all still complete.
