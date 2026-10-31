---
type: Fixed
pr: 5541
---
**`/gsd-code-review --fix --auto` now commits the converged REVIEW.md even when REVIEW-FIX.md is invalid or missing** — the re-review loop rewrote the tracked REVIEW.md but only the valid-report path committed it, so the tree stayed dirty and `/gsd-ship` asked to commit or stash. A malformed REVIEW-FIX.md is still never committed, and when git sees the malformed report, the warning now says it keeps `/gsd-ship` asking to commit or stash until it is fixed or deleted. (#5527)
