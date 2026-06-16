---
name: gsd-context
description: "codebase intel | map graphify docs learnings mempalace"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [map-codebase, graphify, docs-update, extract-learnings, mempalace-recall, mempalace-capture]
---

Route to the appropriate codebase-intelligence skill based on the user's intent.
`gsd-scan` and `gsd-intel` were folded into `gsd-map-codebase` flags by #2790.

| User wants | Invoke |
|---|---|
| Map the full codebase structure | gsd-map-codebase |
| Quick lightweight codebase scan | gsd-map-codebase --fast |
| Query mapped intelligence files | gsd-map-codebase --query |
| Generate a knowledge graph | gsd-graphify |
| Update project documentation | gsd-docs-update |
| Extract learnings from a completed phase | gsd-extract-learnings |
| Recall prior decisions and patterns before planning | gsd-mempalace-recall |
| File a phase artifact into MemPalace | gsd-mempalace-capture |

Invoke the matched skill directly using the Skill tool.
