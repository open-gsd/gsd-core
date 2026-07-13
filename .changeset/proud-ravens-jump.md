---
type: Fixed
pr: 2229
---
**`phase complete` no longer checks the wrong ROADMAP checkbox or writes the plan count into a shipped milestone** — the roadmap mutators ran unanchored and un-milestone-scoped, so they could flip a bullet inside a backticked prose literal or a Backlog entry instead of the closing phase's, and write the plan count into a same-numbered phase in a shipped milestone. The checkbox flip is now line-anchored and both writers are scoped to the current milestone. (#2200)
