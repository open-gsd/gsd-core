---
type: Fixed
pr: 926
---
**`gsd-context-monitor.js` now echoes the actual invoking hook event name** — instead of hardcoding `hookEventName: "PostToolUse"` (or `"AfterTool"` for Gemini), the hook reads `data.hook_event_name` from the stdin payload and falls back to the runtime heuristic only when the field is absent or blank; this fixes Claude Code rejecting hook output with `"expected Stop but got PostToolUse"` when the monitor is invoked by the Stop, SubagentStop, or PreCompact hooks registered in PR #821. (#925)
