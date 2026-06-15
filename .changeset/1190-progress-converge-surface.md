---
type: Added
pr: 1237
---
**`/gsd-progress --next --auto --converge` now routes planning through plan-review convergence.** ADR-15's designated *primary* convergence surface is wired into the progress/next workflow (previously only `/gsd-autonomous --converge` honored it; on `/gsd-progress` the flag was silently dropped). Accepts `--cross-ai` as an alias plus reviewer flags and `--max-cycles N`, and is gated on `workflow.plan_review_convergence`. (#1190)
