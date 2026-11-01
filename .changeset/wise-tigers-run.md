---
type: Fixed
pr: 5411
---
**New Claude projects retain model profile routing after non-Claude installs** — shared resolve_model_ids: "omit" is excluded during project seeding while explicit choices and boolean defaults remain intact. Existing project omit values are preserved and receive a deduplicated Claude diagnostic explaining possible inherited stamping and how to restore tier routing.
