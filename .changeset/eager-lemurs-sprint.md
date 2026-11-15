---
type: Fixed
pr: 0
---
**`resolve-execution --attempt 0` now reports the same model as `resolve-model`** — with `dynamic_routing` enabled on a runtime with its own tier map (Codex, OpenCode), or with a `model_policy` preset or a `model_profile_overrides.claude` pin on Claude Code, the first spawn resolved through `resolve-execution` (and the provider-escalation ladder) used `dynamic_routing.tier_models` while `resolve-model` and the `init` payloads reported the runtime or policy model. A respawn that does not move the tier now gets that same model too; a real escalation still uses `tier_models`. (#6214)
