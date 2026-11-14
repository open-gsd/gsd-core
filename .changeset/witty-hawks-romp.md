---
type: Fixed
pr: 6187
---
**`roadmap update-plan-progress` now inserts a missing plan row into the right `Plans:` list** — a `####` sub-heading, or a `#` line inside a fenced block, between the `**Plans:**` summary and the `Plans:` list no longer strands the row above it, and a `**Plans:**` count placed after a sub-heading is rewritten; insertion and the count now use the same phase scope that missing-row detection reads. (#6169)
