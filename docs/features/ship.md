---
id: 6.5
title: Ship
group: Core Features
---

**Command:** `/gsd-ship [N] [--draft]`

**Purpose:** Bridge local completion → merged PR. After verification passes, push branch, create PR with auto-generated body from planning artifacts, optionally trigger review, and track in STATE.md.

**Requirements:**
- REQ-SHIP-01: System MUST verify phase has passed verification before shipping
- REQ-SHIP-02: System MUST push branch and create PR via `gh` CLI
- REQ-SHIP-03: System MUST auto-generate PR body from SUMMARY.md, VERIFICATION.md, and REQUIREMENTS.md
- REQ-SHIP-04: System MUST update STATE.md with shipping status and PR number
- REQ-SHIP-05: System MUST support `--draft` flag for draft PRs
- REQ-SHIP-06: System MUST support append-only project PR body sections configured with `ship.pr_body_sections`
- REQ-SHIP-07: System MUST refuse a phase whose ROADMAP.md record (checklist entry, progress-table Status) does not read complete, has no record, or sits in an unreadable progress table, before any PR is created (`PHASE_NOT_COMPLETE`, `PHASE_NOT_RECORDED`, `ROADMAP_TABLE_UNREADABLE`; #5221)

**Prerequisites:** Phase verified and recorded complete in ROADMAP.md, `gh` CLI installed and authenticated, `jq` installed, work on feature branch

**Produces:** GitHub PR with rich body, optional configured PRD-style sections, STATE.md updated

**User documentation:** [Custom PR Body Sections](ship-pr-body-sections.md)
