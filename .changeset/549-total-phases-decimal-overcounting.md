---
type: Fixed
pr: 549
---
State progress writer no longer over-counts `total_phases` by 1 when the ROADMAP contains a non-phase section heading (e.g. `## Phase Overview:`) that matched the looser regex in `getMilestonePhaseFilter`. Both `buildStateFrontmatter` and `cmdStateSync` now source `total_phases` from the same digit-anchored phase-heading pattern used by `roadmap.analyze` — single source of truth.
