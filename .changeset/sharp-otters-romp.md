---
type: Added
pr: 1766
---
**`/gsd-review` now supports custom reviewer instances** — run one model-capable adapter (e.g. OpenCode) as several independent reviewer identities via a bounded `review.reviewer_instances` config, so two different models can review in a single pass without manually swapping config or hand-merging REVIEWS.md. (#1517)
