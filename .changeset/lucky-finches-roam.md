---
type: Changed
pr: 6286
---
The Antigravity reviewer lane in `/gsd-review` now asks agy to restate each plan's requirements, wave, depends_on and task count, and flags its review `[incomplete-read]` (with a `read_check` block in REVIEWS.md) when a restatement is missing or wrong, the output was truncated, or agy compacted its context before writing the review (#5491).
