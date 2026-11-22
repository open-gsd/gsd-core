---
type: Added
pr: 0
---
**Capabilities can now guide external code reviewers** — a new `review:pre` loop point lets an enabled capability add `reviewer`-targeted guidance to the single prompt `/gsd-review` (and every `/gsd-plan-review-convergence` cycle) sends to external reviewer lanes, so reviews are judged under the same project guidance as planning. With no such capability the prompt is unchanged; the install summary now names this cross-reviewer egress. (#3997)
