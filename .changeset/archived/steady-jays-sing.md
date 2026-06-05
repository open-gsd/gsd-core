---
type: Security
pr: 572
---
Hardened resolveModelPolicy against prototype pollution: Object.hasOwn guards now block \_\_proto\_\_ / constructor keys in user-supplied provider/budget/runtime_tiers from reaching inherited prototype slots. Also fixed resolveModelForTier to check model_policy before dynamic_routing so provider presets are not silently bypassed when dynamic routing is enabled.
