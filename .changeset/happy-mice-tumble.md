---
type: Fixed
pr: 6295
---
**The CI timeout report no longer records a job that was cancelled while still waiting for a runner as a full-length run** — such a job has a `started_at` (when it was queued) and a later `completed_at` (when it was cancelled), so its queue wait was reported as run time: the near-cap report put it over 100% of its cap and the Windows shard-balance check added a bogus sample that skewed a shard's p90 and the median gap. The shared duration rule now returns no duration for a `cancelled` job with an empty `steps` list, runner id 0 and an empty runner name, so both consumers skip it; a cancelled job that ran, including one killed at its timeout cap, and a record that lacks those fields are still counted. (#6177)
