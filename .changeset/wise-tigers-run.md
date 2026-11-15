---
type: Fixed
pr: 5411
---
**New Claude Code projects no longer copy a shared `resolve_model_ids: "omit"`** — project creation excludes that shared value for Claude Code, so custom agents, `model_profile_overrides.claude` pins and `dynamic_routing` tier models keep resolving through profile routing, while explicit project choices and boolean defaults are preserved. Other runtimes retain the shared omit, including for unknown agents and inherit profiles. Existing project configs are left unchanged.
