---
type: Fixed
pr: 0
---
**`roadmap validate` and `roadmap update-plan-progress` no longer let a deleted PLAN file hide behind its ROADMAP row** — deleting a plan after planning left `validate` silent and left `update-plan-progress` rewriting the `Plans:` count from disk while keeping the missing plan's row, so the count and the list disagreed with no verb to fix it; `validate` now warns (V006) about a plan row with no PLAN file and (V007) about a live PLAN file with no row in a phase that lists its plans, and `update-plan-progress` drops the rows whose file is gone (a row that wraps onto a continuation line is kept and reported). (#6270)
