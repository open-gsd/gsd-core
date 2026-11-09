---
type: Changed
pr: 6069
---
**`/gsd-autonomous` stops asking about reversible technical choices and asks preference questions without a recommendation** — smart discuss now decides cheap-to-undo technical questions (file layout, naming, internal data shapes) itself and lists them in a "Decided autonomously" block, `CONTEXT.md` and `DISCUSSION-LOG.md`; hard-to-reverse questions are still asked with a recommendation, and product/UX questions are asked neutrally. (#5069)
