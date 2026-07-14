---
type: Fixed
pr: 0
---
**`scanPhasePlans` no longer counts PLAN-REVIEW artifacts as executable plans** — files matching `*-PLAN-REVIEW.md` were counted as plans by the loose `/PLAN/i` fallback in `isRootPlanFile`, inflating plan totals from `roadmap analyze` and other consumers. The fix adds a `PLAN_REVIEW_RE` exclusion before the fallback so review artifacts are rejected. (#2252)
