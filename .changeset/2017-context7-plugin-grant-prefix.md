---
type: Fixed
pr: 2029
---
**context7 now works for plugin-marketplace installs (8 agents regained doc lookup)** — the agents granted only `mcp__context7__*`, which matches a standalone context7 MCP server but not the official Claude Code plugin-marketplace install (`context7@claude-plugins-official`), whose tools are named `mcp__plugin_context7_context7__*`. The grant never matched, so advisor/ai/domain/phase/project/ui-researcher + planner + executor silently lost documentation lookup and fell back to WebSearch. All 8 agents now grant both forms, the researcher profile table is updated, and a parity guard asserts no agent grants the standalone form without the plugin form. (#2017)
