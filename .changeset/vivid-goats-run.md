---
type: Fixed
pr: 2263
---
**`scanPhasePlans` no longer counts PLAN-REVIEW artifacts as executable plans** — `*-PLAN-REVIEW.md` files were counted by the loose `/PLAN/i` fallback. The fix adds a `PLAN_REVIEW_RE` exclusion before the fallback. (#2252)
