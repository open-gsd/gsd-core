---
type: Added
pr: 777
---
Cursor now receives GSD lifecycle hooks via `.cursor/hooks.json` — a sessionStart hook injects the current workflow state as context at session start, and a postToolUse hook nudges the agent to update `.planning/` after write-class operations, bringing Cursor to baseline hook parity with Gemini and Claude Code.
