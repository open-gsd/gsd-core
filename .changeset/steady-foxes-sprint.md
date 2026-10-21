---
type: Fixed
pr: 5574
---
**A plan whose id prefixes another no longer ticks the wrong ROADMAP row** — `roadmap update-plan-progress` and `phase complete` matched plan ids by bare prefix, so a `47-1` summary ticked `47-10-PLAN.md` and a superseded plan's summary could tick a live plan. Plan ids now end at a real boundary, and a dotted sub-id such as `01-01.1` is its own plan. (#5542)
