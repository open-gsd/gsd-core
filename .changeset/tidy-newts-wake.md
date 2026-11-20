---
type: Fixed
pr: 6366
---
**The docs-update doc verifier now runs on its resolved model** — `/gsd:docs-update` resolved a model for `gsd-doc-verifier` but never passed it to any of its three verifier spawns, so project `model_profile` and overrides had no effect on the verifier; a new guard fails any workflow that resolves a model it never passes to a spawn. (#5997)
