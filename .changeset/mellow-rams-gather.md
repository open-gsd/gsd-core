---
type: Fixed
pr: 5457
---
**`tdd.review-checkpoint` no longer fails a TDD phase after a squash merge** — `/gsd-ship` now seals each plan's RED/GREEN evidence in `TDD-REVIEW-SEAL.json` and commits it before push, so the credit survives the squash, and a plan whose commits were squashed away without a seal is reported `NotEvaluable` instead of a violation (#5354).
