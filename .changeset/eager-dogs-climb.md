---
type: Fixed
pr: 6362
---
**The wave-guard reference now says a base-check degrade lasts for the remaining waves** — the text said a degrade applied to "this wave only" and that later waves may re-enable worktree isolation, but the shipped shell never restores `USE_WORKTREES` or `ISOLATION`, so later waves skip the re-check and stay sequential. The reference, its degrade message and the base-check message it prints (plus the docs that quote it) now say worktrees can return in a later run, and step 7c's degrade message names the same scope. Runtime behavior is unchanged. (#6049)
