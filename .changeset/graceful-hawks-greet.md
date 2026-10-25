---
type: Fixed
pr: 5668
---
**The loop-hook dispatch reference no longer tells an orchestrator to reject every dotted gate id** — the gate-query rule now says to replace each `.` with `-` first (as `gsd_run check` does) and then validate and pass that normalized value, so shipped query gates such as `ui.plan-gate` and `verify.codebase-drift` are run instead of skipped as a malformed manifest; quotes, `;`, backticks, `$(`, newlines, uppercase and leading, trailing or doubled dots are still rejected. (#5647)
