---
type: Fixed
pr: 0
---
**Dynamic routing now escalates the model, not just effort** — with `dynamic_routing.enabled`, retry attempts advanced the reasoning effort but the model stayed pinned to the default tier because `resolve-execution` resolved the model without consulting `dynamic_routing`. `resolve-execution` now resolves the model per-attempt through the tier ladder (e.g. standard→heavy on attempt 1, capped at `max_escalations`); resolution is unchanged when dynamic routing is disabled. (#2068)
