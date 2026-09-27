---
type: Fixed
pr: 0
---
**`phase.plan-index` and the other readers of a `*-PLAN.md` file's frontmatter (`wave`, `depends_on`, `autonomous`, `agent_hint`, `files_modified`, `files_deleted`, `type`, `objective`) now read through the same PlanningDoc seam every other planning-document field goes through, instead of a separate call path** — closing a naming-collision risk between `src/plan-document.cts` and the seam that the epic behind #4906 flagged but never resolved. No user-facing command, flag, or output changed; every value returned is byte-identical to before. (#5026)
