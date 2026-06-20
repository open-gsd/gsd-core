---
type: Fixed
pr: 1490
---

**999.x backlog phases are now excluded from `total_phases`, and `total_phases` can correct downward** — `deriveProgressFromRoadmap` counted all progress-table rows whose phase cell started with a digit, so a `999.1 Backlog` row inflated `total_phases` by one per entry (#1445). The same overcounting occurred in `getMilestonePhaseFilter` (which feeds `isDirInMilestone` and `phaseDirs`) and in the `roadmapPhaseCount` loop in `buildStateFrontmatter`. All three sites now filter phase tokens matching `/^999\b/`, consistent with the existing exclusion in `init.cts`. Additionally, `shouldPreserveExistingProgress` included `total_phases` in its ratchet check, preventing the counter from decreasing once set too high — e.g. after a 999.x fix or a ROADMAP correction (#1446). `total_phases` is now always taken from the freshly derived value; only `completed_phases`, `total_plans`, and `completed_plans` retain ratchet behaviour.
