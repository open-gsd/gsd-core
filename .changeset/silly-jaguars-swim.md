---
type: Added
pr: 49
---
Add `model_policy` config surface with known-provider presets (openai/anthropic/google/qwen) and `generic` provider escape hatch. `model_policy.runtime_tiers` resolves before legacy `model_profile_overrides`. `reasoning_effort` is stripped for unsupported runtimes.
