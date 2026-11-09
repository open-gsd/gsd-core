---
type: Added
pr: 5413
---
**On Claude Code, Agent() calls are checked against the model GSD resolved** — an orchestrator that passed `gsd-executor`, `gsd-verifier`, `gsd-plan-checker` or `gsd-planner` a model other than the resolved one ran that agent on the wrong tier without a word; the isolation hook now warns (or, with `hooks.agent_model_guard: "deny"`, blocks a wrong or an omitted model) and accepts a model `resolve-execution --attempt N` recorded within the last 10 minutes; with `--ws`, `init` records the workstream name for the session (the newest eight, each for 12 hours) so a model matching any recorded workstream's baseline or the `GSD_WORKSTREAM`/pointer one passes (#5328).
