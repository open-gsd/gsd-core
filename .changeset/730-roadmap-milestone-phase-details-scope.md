---
type: Fixed
pr: 748
---
The roadmap parser now resolves fresh phases of the current milestone in multi-milestone roadmaps. `extractCurrentMilestone()` scoped the current-milestone window to its `## Phases` checklist subsection and stopped at the milestone's own `## Milestone … (Phase Details)` heading, so the `### Phase N:` detail headers fell out of scope. Any command backed by the parser — `init.phase-op` (and therefore `/gsd:discuss-phase` and `/gsd:plan-phase`), `state`, `roadmap list`, and `validate health` (W006) — could not resolve phases of any milestone after the first until a `.planning/phases/` directory already existed, blocking discuss/plan. The parser now also includes the current milestone's `(Phase Details)` section in scope, anchored to the selected milestone's version token so sibling sub-milestones do not cross-pollinate. (#730)
