---
type: Changed
pr: 591
---
**`gsd-roadmapper` granularity defaults tightened to reduce thin-phase fragmentation.** Coarse 3-5 -> 2-4, Standard 4-6 (was 5-8), Fine 6-10 (was 8-12). New inline guidance below the Granularity Calibration table names the thin-phase failure pattern (single requirement, internal-quality goal, task-shaped success criteria) and instructs the agent to fold into the most-related neighbor rather than create a standalone phase. Affects `/gsd-new-project`, `/gsd-new-milestone`, and `/gsd-plan-milestone-gaps`.
