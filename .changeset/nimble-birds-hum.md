---
type: Fixed
pr: 6023
---
**Inserted phases no longer carry "(INSERTED)" into their name** — `roadmap get-phase` and every init command's `phase_name` kept the marker `phase insert` writes into the heading, so `execute-phase` wrote it into STATE.md's current phase name and the Phase line could not be read back; the name is now bare everywhere, matching `roadmap analyze` (#5824).
