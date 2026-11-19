---
type: Fixed
pr: 6362
---
**The wave-guard reference now says a base-check degrade lasts for the remaining waves** — the text said a degrade applied to "this wave only" and that later waves may re-enable worktree isolation, but the shipped shell never restores `USE_WORKTREES` or `ISOLATION`, so later waves skip the re-check and stay sequential. The reference and its degrade message now match step 7c. Runtime behavior is unchanged. (#6049)
