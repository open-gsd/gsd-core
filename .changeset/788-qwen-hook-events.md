---
type: Added
pr: 802
---
Qwen Code installs now register three additional hook events that Qwen Code supports beyond Claude Code: `SubagentStop`, `Stop`, and `PreCompact` — all wired to `gsd-context-monitor.js` for context headroom tracking at subagent completion, model stop, and pre-compaction. These events are Qwen-only; Claude Code installs are unchanged. `UserPromptSubmit` is deferred: `gsd-prompt-guard` exits unless `tool_name` is `Write|Edit`, making it a no-op for that payload shape. (#788)
