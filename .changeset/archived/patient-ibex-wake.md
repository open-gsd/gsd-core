---
type: Added
pr: 487
---
Added a plan-vs-codebase drift guard. /gsd:plan-review-convergence now verifies (default on, plan_review.source_grounding) that symbols a plan cites actually exist in your source, flagging hallucinated names as needs-acknowledgement before execution instead of at runtime; UNCHECKABLE cases are logged, never silently passed. With intel enabled, the planner also receives a rendered API-SURFACE.md hint (gsd-tools intel api-surface). The resolver authority is configurable via plan_review.source_grounding_authority (grep|intel|...).
