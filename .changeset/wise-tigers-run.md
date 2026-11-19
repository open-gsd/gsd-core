---
type: Fixed
pr: 5411
---
**New Claude Code projects keep model profile routing when shared defaults set `resolve_model_ids: "omit"`** — project creation no longer copies that shared value into Claude Code projects, so custom agents, `model_profile_overrides.claude` pins and `dynamic_routing` tier models keep resolving through profile routing, while explicit project choices and boolean defaults are preserved. Other runtimes retain the shared omit, including for unknown agents and inherit profiles. Existing project configs are left unchanged.
