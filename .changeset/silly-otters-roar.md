---
type: Fixed
pr: 4931
---
**`roadmap update-plan-progress` no longer wipes the Progress-table Status cell** — it rewrites only the leading status token and keeps any prose after it, no longer clears a `-` Completed placeholder, and no longer leaves the row as `In Progress|  |`. (#4925)
