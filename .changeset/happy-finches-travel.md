---
type: Fixed
pr: 863
---
**`/gsd-manager` and `/gsd-autonomous --interactive` no longer silently skip worktree isolation and independent verification on Claude Code.** They dispatched plan/execute as background agents, but a backgrounded Claude Code agent has no Agent/Task tool and cannot spawn the nested executors, plan-checker, or verifier — so isolation and verification silently never ran. Both workflows now resolve the runtime and run plan/execute inline on Claude Code (background dispatch is kept on runtimes that support nested subagents).
