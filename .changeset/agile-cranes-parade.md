---
type: Fixed
pr: 0
---
**`roadmap analyze` now reports phases whose ROADMAP checkbox disagrees with their disk status** — a `[x]` backfilled phase (summary, no plans) or a fully summarized `[x]` phase without a passing VERIFICATION is still returned as `next_phase`/`current_phase` (selectors stay disk-authoritative per ADR-3180), and a new `checkbox_conflict` list names each such phase instead of handing back a completed phase with no signal. (#4757)
