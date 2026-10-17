---
type: Added
pr: 5413
---
Agent model guard: the isolation hook now warns (or denies via hooks.agent_model_guard) when an Agent()/Task() call for gsd-executor, gsd-verifier, gsd-plan-checker or gsd-planner passes a model other than the one GSD resolved, accepting models recorded by resolve-execution --attempt N (#5328).
