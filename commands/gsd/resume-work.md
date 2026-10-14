---
name: gsd:resume-work
description: Resume work from previous session with full context restoration
allowed-tools:
  - Read
  - Bash
  - Grep
  - Write
  - AskUserQuestion
  - SlashCommand
---

<objective>
Restore complete project context and resume work seamlessly from previous session.

Routes to the resume-project workflow which handles:

- STATE.md loading (or reconstruction if missing)
- Checkpoint detection (.continue-here files, keyed per session/role: `HANDOFF.latest.<role_id>.json` / `HANDOFF.<session_id>.json`; only this session's own handoff is consumed)
- Incomplete work detection (PLAN without SUMMARY)
- Status presentation
- Context-aware next action routing
  </objective>

<execution_context>
@~/.claude/gsd-core/workflows/resume-project.md
</execution_context>

<process>
Execute end-to-end.
</process>
