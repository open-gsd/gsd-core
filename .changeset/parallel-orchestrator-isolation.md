---
type: Fixed
pr: 5891
---
**Two orchestrators in one checkout no longer deny each other's sequential dispatches** — when parallel workstreams ran execute-phase in the same checkout, each recorded isolation decision overwrote the other's, so a plan resolved to run without a worktree was refused by the isolation guard; each dispatch's decision is now kept for its own phase and plan. (#5682)
