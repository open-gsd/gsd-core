---
type: Fixed
pr: 4694
---
**A merged-and-deleted phase branch is no longer resurrected by a post-merge phase-scoped commit** — `query commit` re-created the deleted branch and moved HEAD onto it (the #3079 hijack reopened by #3363); the create arm now requires a genuinely new phase (no committed history touching the phase directory, caller on the resolved base branch) and otherwise commits in place with a disclosed warning. and refusing to recreate an absent phase branch when the caller is off the resolved base branch. The milestone arm keeps its existence-only guard in this fix (its state-3 exposure is unchanged and named at the guard site) but now also requires the base branch before creating. (#4055)
