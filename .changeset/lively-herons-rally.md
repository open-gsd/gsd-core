---
type: Fixed
pr: 2083
---
**`resolve-execution --attempt` now escalates the model through `dynamic_routing.tier_models`** — previously only effort escalated; the model was resolved outside the tier table and never changed on retry.
