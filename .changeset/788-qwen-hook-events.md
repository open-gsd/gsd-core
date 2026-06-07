---
type: Added
pr: 802
---
Qwen Code installs now register four additional hook events that Qwen Code supports beyond Claude Code: `SubagentStop`, `Stop`, and `PreCompact` (all wired to `gsd-context-monitor.js` for context headroom tracking at subagent completion, model stop, and pre-compaction), and `UserPromptSubmit` (wired to `gsd-prompt-guard.js` for prompt injection scanning on user input). These events are Qwen-only; Claude Code installs are unchanged. (#788)
