---
type: Fixed
pr: 1172
---
**`state update` and `roadmap update-plan-progress` now handle current Markdown artifact shapes** — state field read/replace works on table-format `STATE.md` (`| Status | … |`), and `roadmap update-plan-progress` inserts missing per-plan checklist rows (filling partial gaps), tolerates `Plans:`/`**Plans:**`/`**Plans**:`, and scopes changes to the active milestone.
