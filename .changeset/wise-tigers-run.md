---
type: Fixed
pr: 5411
---
**New Claude Code projects keep model profile routing when shared defaults set `resolve_model_ids: "omit"`** — project creation excludes that shared value for Claude Code while preserving explicit project choices and boolean defaults. Other runtimes retain the shared omit, including for unknown agents and inherit profiles. Existing projects keep their settings and receive a warning explaining how to restore Claude profile routing when an inherited omit was unintended.
