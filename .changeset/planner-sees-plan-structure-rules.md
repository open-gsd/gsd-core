---
type: Fixed
pr: 0
---
**The planner is now shown `verify.plan-structure`'s rules before it writes a plan** — the validator refuses quantitative-criteria shapes (R1-R6) and `executor_runtime`/`agent_hint` frontmatter combinations that were documented nowhere the planner loads, so plans kept failing validation on rules the planner had never been told about; the planner-loaded guidance reference now names every rule id with its corrected form, the `plan-criteria-allow` exit and its required reason, and the frontmatter refusals, and the preconditions reference no longer reads as a complete description of the validator. (#6464)
