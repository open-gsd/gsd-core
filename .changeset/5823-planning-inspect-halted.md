---
type: Added
pr: 6101
---
**`planning inspect` reports halted plans beside the counts that include them** — a plan that stopped at a designed halt (`status: halted` in its SUMMARY) read as an ordinary finished plan, so a tool built on `planning inspect` showed the phase as done and had to call `phase-plan-index` a second time to learn otherwise; each plan row now carries `halted` and `blocked_by`, each phase row a `halted_count` beside `summary_count`, and `progress` a `halted_plans` fraction beside `completed_plans`, computed the way `phase-plan-index` computes them. `hasSummary`, `summary_count` and `completed_plans` are unchanged and still count a halted plan as completed. (#5823)
