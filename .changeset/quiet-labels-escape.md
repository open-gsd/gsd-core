---
type: Changed
pr: 5413
---
**`audit-open` and base-branch labels escape format and line-separator characters** — a name holding a zero-width, bidirectional, soft-hyphen, U+2028 or U+2029 character now prints as `\uNNNN`, so it cannot hide text or break the line. (#5328)
