---
type: Changed
pr: 4771
---
**`/gsd-autonomous --converge` now overrides the convergence config gate** — an explicit `--converge` or `--cross-ai` enables plan-review convergence for that run even when `workflow.plan_review_convergence` is `false`, instead of stopping with an enable instruction; without the flag the config decides, as before. (#4600)
