---
type: Added
pr: 5413
---
**Agent() calls are checked against the model GSD resolved** — the isolation hook now warns (or denies a wrong model, via `hooks.agent_model_guard`; an omitted `model` only warns) when an orchestrator passes `gsd-executor`, `gsd-verifier`, `gsd-plan-checker` or `gsd-planner` a model other than the resolved one, and accepts a model recorded by `resolve-execution --attempt N` for 10 minutes (#5328).
