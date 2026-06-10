---
name: gsd-project
description: "project lifecycle | milestones audits summary"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [new-project, new-milestone, complete-milestone, audit-milestone, milestone-summary, import, ingest-docs, profile-user, review-backlog]
---

Route to the appropriate project / milestone skill based on the user's intent.
`gsd-plan-milestone-gaps` was deleted by #2790 — gap planning now happens
inline as part of `gsd-audit-milestone`'s output.

| User wants | Invoke |
|---|---|
| Start a new project | gsd-new-project |
| Create a new milestone | gsd-new-milestone |
| Complete the current milestone | gsd-complete-milestone |
| Audit a milestone for issues | gsd-audit-milestone |
| Summarize milestone status | gsd-milestone-summary |
| Import an external plan | gsd-import |
| Bootstrap planning from existing docs | gsd-ingest-docs |
| Generate a developer profile | gsd-profile-user |
| Review and promote backlog items | gsd-review-backlog |

Invoke the matched skill directly using the Skill tool.
