---
type: Changed
pr: 746
---
**`/gsd:plan-phase` and `/gsd:execute-phase` no longer eagerly load MVP-only guidance on non-MVP runs** — the MVP planner rules, user-story template, Walking-Skeleton template, and MVP+TDD halt-report reference are now Read lazily by the planner/executor only when MVP / Walking-Skeleton / MVP+TDD mode is active, in both the workflow files and the `gsd-planner`/`gsd-executor` agent definitions, instead of being `@`-imported into every run. Behaviour is unchanged; non-MVP planning/execution simply carries less context. (#720)
