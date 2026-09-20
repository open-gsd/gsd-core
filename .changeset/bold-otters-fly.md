---
type: Fixed
pr: 4880
---
**roadmap update-plan-progress stops inserting a duplicate plan list beside hand-written ones** — plan checkbox rows written without the -PLAN.md suffix (the hand-written form) were not recognized, so the verb inserted its own canonical list above them, leaving two competing lists for the same plans; suffix-less rows are now recognized and ticked in place. (#4786)
