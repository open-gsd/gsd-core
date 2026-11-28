---
type: Fixed
pr: 6362
---
**The wave-guard reference now says a base-check degrade lasts for the remaining waves** — the text said a degrade applied to "this wave only" and that later waves may re-enable worktree isolation, but once the guard sets `USE_WORKTREES=false` and `ISOLATION=none` nothing in the wave loop sets them back (the isolation-dispatch step re-forces `ISOLATION=none` while `USE_WORKTREES=false`), so later waves skip the re-check and stay sequential. The wave guard's degrade echo now says "remaining waves" (step 7c already did), and the wave-guard reference prose says the same; the base-check messages the guard prints and the docs that quote them now say worktrees can return in a later run. Only message text and prose change (including the `message` strings `worktree base-check` returns); no control flow changes. (#6049)
