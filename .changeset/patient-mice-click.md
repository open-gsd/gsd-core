---
type: Added
pr: 6307
---
**A plan can declare `executor_runtime`, and a new opt-in gate and model keys are registered** — `phase-plan-index` now emits `executor_runtime` for each plan (`null` when unset), `verify plan-structure` refuses it on a plan with `autonomous: false`, a `checkpoint:*` task or an `agent_hint`, and `workflow.cross_runtime_execution` (default `false`) plus `execute.models.<runtime>` are accepted by `config-set`. Nothing dispatches on them yet; the dispatch lands with the cross-runtime executor work (#3711). (#6302)
