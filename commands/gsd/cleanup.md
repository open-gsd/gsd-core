---
name: gsd:cleanup
description: Archive accumulated phase directories from completed milestones
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - AskUserQuestion
requires: [phase]
---
<objective>
Archive phase directories from completed milestones into `.planning/milestones/v{X.Y}-phases/`.

Use when `{planning_root}/phases/` has accumulated directories from past milestones. (`{planning_root}`: the active scope's root, from `planning.inspect`)
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/cleanup.md
</execution_context>

<process>
Execute end-to-end.
Identify completed milestones, show a dry-run summary, and archive on confirmation.
</process>
