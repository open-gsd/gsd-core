---
type: Fixed
pr: 0
---
**A ROADMAP heading that only mentions a milestone's version no longer becomes that milestone's heading** — `## Carried forward to v0.5.0 (inputs, not phases)` was selected as the v0.5.0 heading, so every STATE.md write replaced the curated `milestone_name` with `(inputs, not phases)`, even when the real `## v0.5.0 Search Revamp` heading came later. A heading now counts as a version's milestone heading only when the version token leads its text (only ✅ 📋 🚧, bold markers and the word `Milestone` may precede it), and selection and section detection read that one rule, so a mention heading is neither selected, counted as a section, nor the end of the previous milestone's window. (#6149)
