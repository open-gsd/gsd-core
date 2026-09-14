---
type: Fixed
pr: 4718
---
**`/gsd:debug` no longer spawns duplicate debuggers that collide on the session file** — the debug session manager spawned its `gsd-debugger` without `run_in_background=false`, so Claude Code backgrounded it, the manager had no result to inspect, and it returned a non-terminal summary. The orchestrator's auto-resume then started a second debugger against the same `.planning/debug/<slug>.md`, up to the three-resume cap — which is why the collision showed up exactly three times per invocation. The spawn now blocks, matching the rule already applied one level up (#2196). (#4395)
