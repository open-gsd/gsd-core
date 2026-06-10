---
type: Fixed
pr: 842
---
Codex agent TOML generation no longer pins `model_reasoning_effort` when the agent is intentionally inheriting the active Codex chat model. GSD still emits both `model` and `model_reasoning_effort` when a per-agent model override or `runtime: "codex"` resolver pins the model, avoiding the confusing partial state where the model followed Codex UI selection while effort followed GSD catalog defaults. (#838)
