---
type: Fixed
pr: 5357
---
**The stale-verification message now names a phase plan or summary the report never covered (#4817)** — an older (v1/v2) verification report that never declared one of the phase's own plans or summaries read `stale` with "covered source files changed", which was false for that cause and named nothing. `verification status` now returns `uncovered_artifacts` and `next_action` names them and says whether a covered file also changed. The route is unchanged: re-run `execute-phase`.
