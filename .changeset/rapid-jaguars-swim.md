---
type: Added
pr: 0
---
**`/gsd-config --advanced` now lets you set the planner stall threshold and check interval** — if plan-phase keeps flagging a slow but still-working planner as stalled, raise `planner.stall_threshold_minutes` from the Planning Tuning prompts instead of editing `config.json`; defaults stay 10 and 5 minutes. (#3923)
