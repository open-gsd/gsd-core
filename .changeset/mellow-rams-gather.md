---
type: Fixed
pr: 5457
---
**`tdd.review-checkpoint` no longer fails a TDD phase after a squash merge** — a squash merge made a passing TDD plan fail the review checkpoint. Now the evidence survives the squash, or the plan shows as not evaluable instead of failing. (#5354)
