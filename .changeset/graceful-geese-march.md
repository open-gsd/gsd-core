---
type: Changed
pr: 2417
---
**`/gsd-plan-review-convergence` no longer lets a lone reviewer's unverified HIGH force a replan** — when `review.reviewer_instances` runs 2+ reviewers in a cycle, a HIGH raised by a single reviewer now counts toward `current_high` only if it is independently source-grounded (a verified `file:line` citation) or corroborated by another reviewer's finding in REVIEWS.md's Consensus Summary. An uncorroborated single-reviewer HIGH still appears under "Current HIGH Concerns" tagged `(single-reviewer, unconfirmed)` for visibility but no longer blocks convergence on its own. Single-reviewer configurations are unchanged. (#2417)
