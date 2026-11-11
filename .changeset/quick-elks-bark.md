---
type: Changed
pr: 6070
---
**The Claude orchestration Workflow backend now checks whether workflows are actually turned on** — detection used to gate on the installed Agent SDK version, which says nothing about a Claude Code session, and missed an organization or user that had disabled workflows. It now honors CLAUDE_CODE_DISABLE_WORKFLOWS and disableWorkflows / enableWorkflows in managed, project and user settings, refuses to emit a script past Claude Code's 4,096-per-call and 1,000-agent caps, and gets each worktree's metadata back as validated structured output. (#4747)
