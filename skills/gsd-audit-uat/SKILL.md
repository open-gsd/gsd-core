---
name: gsd-audit-uat
description: "Cross-phase audit of all outstanding UAT and verification items"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
---

<objective>
Scan all phases for pending, skipped, blocked, and human_needed UAT items. Cross-reference against codebase to detect stale documentation. Produce prioritized human test plan.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/audit-uat.md
</execution_context>

<context>
Core planning files are loaded in-workflow via CLI.

**Scope:**
Glob: {planning_root}/phases/*/*-UAT.md (`{planning_root}`: the active scope's root, from `planning.inspect`)
Glob: {planning_root}/phases/*/*-VERIFICATION.md
Archive (also scanned, same two patterns inside each phase directory): `{planning_root}/milestones/v*-phases/*/` and `{planning_root}/milestones/ws-*/phases/*/`, and the same two shapes (`.planning/workstreams/<name>/milestones/v*-phases/*/`, `.planning/workstreams/<name>/milestones/ws-*/phases/*/`) for every workstream
</context>
