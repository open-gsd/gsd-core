---
type: Added
pr: 788
---
gsd now registers four additional hook events for Qwen Code (and Claude Code): `PreCompact`, `SubagentStop`, `Stop`, and `UserPromptSubmit`. Each is implemented as a new community hook script (`gsd-pre-compact.sh`, `gsd-subagent-state.sh`, `gsd-stop-state.sh`, `gsd-user-prompt-submit.sh`) that follows the existing opt-in pattern (`hooks.community: true` in `.planning/config.json`). The hooks emit structured `hookSpecificOutput` JSON for state snapshotting before compaction, subagent lifecycle tracking, session-end summaries, and per-prompt context orientation. Uninstall cleanup covers all four new events. (#788)
