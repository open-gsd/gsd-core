---
type: Fixed
pr: 6362
---
**The wave-guard reference now says a base-check degrade lasts for the remaining waves** — the text said a degrade applied to "this wave only" and that later waves may re-enable worktree isolation, but once the guard sets `USE_WORKTREES=false` and `ISOLATION=none` nothing in the wave loop sets them back (the isolation-dispatch step re-forces `ISOLATION=none` while `USE_WORKTREES=false`), so later waves skip the re-check and stay sequential. The wave guard's degrade echo and step 7c's degrade message now both say "remaining waves"; the base-check messages the guard prints and the docs that quote them now say worktrees can return in a later run. Runtime behavior is unchanged. (#6049)
