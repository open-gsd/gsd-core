---
type: Changed
pr: 2169
---

**CodeBuddy now wires GSD's full extended lifecycle hook set and is driven by its capability descriptor** — installing GSD into CodeBuddy now registers `SubagentStart`, `SubagentStop`, `Stop`, and `PreCompact` hooks in its `settings.json` (it previously had none of these), matching the coverage Qwen/Kimi already ship, and CodeBuddy's install is fully descriptor-driven instead of via residual hardcoded runtime branches. (#2098)
