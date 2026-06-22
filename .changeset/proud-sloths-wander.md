---
type: Fixed
pr: 1539
---
`roadmap upgrade` now rejects an unsupported or malformed `--convention` value (including the `--convention=` form) instead of silently running the milestone-prefixed migration, and no longer hard-exits inside the command-routing hub.
