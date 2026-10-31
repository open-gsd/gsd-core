# Roadmap Template

Template for `.planning/ROADMAP.md`.

<!-- PHASE-ID-CONVENTION:START -->
Resolve phase_id_convention independently of phase_naming. Use returned paths; never derive them from display labels.
Use CLI display_id when present; otherwise use reference grammar. Before emitting identities, Read `~/.claude/gsd-core/references/phase-id-convention.md`.
<!-- PHASE-ID-CONVENTION:END -->

Copy only the fenced artifact body. Convention guidance is instruction text and must not appear in the artifact.

For Progress cells, `phase_table_id` is the CLI `phase_number` with only the configured project-code prefix removed. Keep its numeric milestone/phase spelling; never substitute `display_id` in that machine-readable column. Sequential examples retain bare phase numbers.

## Initial Roadmap (v1.0 Greenfield)

```markdown
# Roadmap: [Project Name]

## Overview

[One paragraph describing the journey from start to finish]

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **{phase_display}: [Name]** - [One-line description]
- [ ] **{phase_display}: [Name]** - [One-line description]
- [ ] **{phase_display}: [Name]** - [One-line description]
- [ ] **{phase_display}: [Name]** - [One-line description]

## Phase Details

### {phase_display}: [Name]
**Goal**: [What this phase delivers]
**Depends on**: Nothing (first phase)
**Requirements**: [REQ-01, REQ-02, REQ-03]  <!-- brackets optional, parser handles both formats -->
**Success Criteria** (what must be TRUE):
  1. [Observable behavior from user perspective]
  2. [Observable behavior from user perspective]
  3. [Observable behavior from user perspective]
**Plans**: [Number of plans, e.g., "3 plans" or "TBD"]

Plans:
- [ ] {plan_display}: [Brief description of first plan]
- [ ] {plan_display}: [Brief description of second plan]
- [ ] {plan_display}: [Brief description of third plan]

### {phase_display}: [Name]
**Goal**: [What this phase delivers]
**Depends on**: {dependency_phase_display}
**Requirements**: [REQ-04, REQ-05]
**Success Criteria** (what must be TRUE):
  1. [Observable behavior from user perspective]
  2. [Observable behavior from user perspective]
**Plans**: [Number of plans]

Plans:
- [ ] {plan_display}: [Brief description]
- [ ] {plan_display}: [Brief description]

### {phase_display}: Critical Fix (INSERTED)
**Goal**: [Urgent work inserted between phases]
**Depends on**: {dependency_phase_display}
**Success Criteria** (what must be TRUE):
  1. [What the fix achieves]
**Plans**: 1 plan

Plans:
- [ ] {plan_display}: [Description]

### {phase_display}: [Name]
**Goal**: [What this phase delivers]
**Depends on**: {dependency_phase_display}
**Requirements**: [REQ-06, REQ-07, REQ-08]
**Success Criteria** (what must be TRUE):
  1. [Observable behavior from user perspective]
  2. [Observable behavior from user perspective]
  3. [Observable behavior from user perspective]
**Plans**: [Number of plans]

Plans:
- [ ] {plan_display}: [Brief description]
- [ ] {plan_display}: [Brief description]

### {phase_display}: [Name]
**Goal**: [What this phase delivers]
**Depends on**: {dependency_phase_display}
**Requirements**: [REQ-09, REQ-10]
**Success Criteria** (what must be TRUE):
  1. [Observable behavior from user perspective]
  2. [Observable behavior from user perspective]
**Plans**: [Number of plans]

Plans:
- [ ] {plan_display}: [Brief description]

## Progress

**Execution Order:**
Phases execute in numeric order: 2 → 2.1 → 2.2 → 3 → 3.1 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| {phase_table_id}. [Name] | 0/3 | Not started | - |
| {phase_table_id}. [Name] | 0/2 | Not started | - |
| {phase_table_id}. [Name] | 0/2 | Not started | - |
| {phase_table_id}. [Name] | 0/1 | Not started | - |
```

<guidelines>
**Initial planning (v1.0):**
- Phase count depends on granularity setting (coarse: 3-5, standard: 5-8, fine: 8-12)
- Each phase delivers something coherent
- Phases can have 1+ plans (split if >3 tasks or multiple subsystems)
- Use the resolved {plan_path}; sequential example: 01-02-PLAN.md
- No time estimates (this isn't enterprise PM)
- Progress table updated by execute workflow
- Plan count can be "TBD" initially, refined during planning

**Success criteria:**
- 2-5 observable behaviors per phase (from user's perspective)
- Cross-checked against requirements during roadmap creation
- Flow downstream to `must_haves` in plan-phase
- Verified by verify-phase after execution
- Format: "User can [action]" or "[Thing] works/exists"

**After milestones ship:**
- Collapse completed milestones in `<details>` tags
- Add new milestone sections for upcoming work
- Preserve resolved phase order within each milestone
</guidelines>

<status_values>
- `Not started` - Haven't begun
- `In progress` - Currently working
- `Complete` - Done (add completion date)
- `Deferred` - Pushed to later (with reason)
</status_values>

## Milestone-Grouped Roadmap (After v1.0 Ships)

After completing first milestone, reorganize with milestone groupings:

```markdown
# Roadmap: [Project Name]

## Milestones

- ✅ **{shipped_milestone_display} MVP** - Phases 1-4 (shipped YYYY-MM-DD)
- 🚧 **{active_milestone_display} [Name]** - Phases 5-6 (in progress)
- 📋 **{planned_milestone_display} [Name]** - Phases 7-10 (planned)

## Phases

<details>
<summary>✅ {shipped_milestone_display} MVP (Phases 1-4) - SHIPPED YYYY-MM-DD</summary>

### {phase_display}: [Name]
**Goal**: [What this phase delivers]
**Plans**: 3 plans

Plans:
- [x] {plan_display}: [Brief description]
- [x] {plan_display}: [Brief description]
- [x] {plan_display}: [Brief description]

[... remaining v1.0 phases ...]

</details>

## {active_milestone_display} [Name] 🚧 (In Progress)

**Milestone Goal:** [What v1.1 delivers]

#### {phase_display}: [Name]
**Goal**: [What this phase delivers]
**Depends on**: {dependency_phase_display}
**Plans**: 2 plans

Plans:
- [ ] {plan_display}: [Brief description]
- [ ] {plan_display}: [Brief description]

[... remaining v1.1 phases ...]

## {planned_milestone_display} [Name] 📋 (Planned)

**Milestone Goal:** [What v2.0 delivers]

[... v2.0 phases ...]

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| {phase_table_id}. Foundation | v1.0 | 3/3 | Complete | YYYY-MM-DD |
| {phase_table_id}. Features | v1.0 | 2/2 | Complete | YYYY-MM-DD |
| {phase_table_id}. Security | v1.1 | 0/2 | Not started | - |
```

**Notes:**
- Milestone emoji: ✅ shipped, 🚧 in progress, 📋 planned
- Completed milestones collapsed in `<details>` for readability
- Current/future milestones expanded
- Configured phase identifiers and order
- Progress table includes milestone column
