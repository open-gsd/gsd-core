---
type: Fixed
pr: 5411
---
**New projects retain model profile routing after cross-runtime installs** — shared resolve_model_ids: "omit" is excluded when the active runtime is Claude or has its own model tier map, while runtimes without a tier map keep omit to avoid receiving an unsupported Claude alias. Explicit choices and boolean defaults remain intact. Existing project omit values are preserved and receive a deduplicated Claude diagnostic explaining possible inherited stamping and how to restore tier routing.
