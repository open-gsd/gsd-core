---
type: Fixed
pr: 0
---
**A merged-and-deleted phase branch is no longer resurrected by a post-merge phase-scoped commit** — `query commit` re-created the deleted branch and moved HEAD onto it (the #3079 hijack reopened by #3363); the create arm now requires a genuinely new phase (no committed history touching the phase directory, caller on the resolved base branch) and otherwise commits in place with a disclosed warning. (#4055)
