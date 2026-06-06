---
type: Fixed
pr: 513
---
**Milestone phase counts no longer leak across a flat `## Phase Details` section** — when a ROADMAP listed per-phase details in a single flat `## Phase Details` section before the milestone headings, `extractCurrentMilestone` folded every milestone's `### Phase N:` entries into the active-milestone scope, so `state json` over-counted `total_phases`/`total_plans` (the whole project instead of the active milestone). The preamble now strips flat phase-detail blocks, and `validate consistency` / `validate health` (W007) compare on-disk phase dirs against the full roadmap so shipped-milestone dirs are not flagged as orphans once the scope is correctly narrowed. (#501)
