# Planning artifacts reference

The `.planning/` directory is GSD Core's shared memory for a project. Every workflow reads from it, writes to it, and leaves an auditable trail of decisions. This page maps every file, its purpose, and which command produces or consumes it. See [docs index](../README.md).

---

## Directory layout

```
.planning/
├── PROJECT.md                          # Project identity and core value
├── ROADMAP.md                          # Milestone + phase listing with goals
├── REQUIREMENTS.md                     # Numbered acceptance criteria
├── STATE.md                            # Living position tracker
├── config.json                         # Workflow and model configuration
├── MILESTONES.md                       # Milestone archive (optional)
├── BACKLOG.md                          # Deferred and future work (optional)
├── LEARNINGS.md                        # Accumulated cross-phase learnings (optional)
├── DECISIONS-INDEX.md                  # Rolling summary of prior decisions (optional)
├── METHODOLOGY.md                      # Reusable interpretive frameworks (optional)
├── HANDOFF.json                        # Machine-readable pause state (transient)
├── codebase/                           # Codebase maps (optional)
│   ├── architecture.md
│   ├── stack.md
│   └── ...
├── intel/                              # Queryable symbol index (optional, intel.enabled)
│   └── API-SURFACE.md
└── phases/
    └── <NN>-<slug>/                    # One directory per phase
        ├── <NN>-CONTEXT.md             # Implementation decisions (discuss-phase)
        ├── <NN>-DISCUSSION-LOG.md      # Human-readable discussion audit (discuss-phase)
        ├── <NN>-RESEARCH.md            # Technical research findings (plan-phase)
        ├── <NN>-VALIDATION.md          # Nyquist test-coverage strategy (plan-phase)
        ├── <NN>-PATTERNS.md            # Codebase analog map (plan-phase, optional)
        ├── <NN>-<PP>-PLAN.md           # Executable plan (plan-phase, one per plan)
        ├── <NN>-<PP>-SUMMARY.md        # Execution record (execute-phase, one per plan)
        ├── <NN>-VERIFICATION.md        # Phase goal verification report (verify-phase)
        ├── <NN>-UAT.md                 # Persistent UAT session state (execute-phase)
        └── .continue-here.md           # Resume instructions after pause (pause-work)
```

---

## Root-level artifacts

### `PROJECT.md`

| | |
|---|---|
| **Purpose** | Canonical project identity: what it is, who it is for, core value, requirements, constraints, and key decisions. Updated throughout the project lifecycle as the product evolves. |
| **Produced by** | `/gsd-new-project` (initial creation); updated by `/gsd-complete-milestone` as decisions are validated. |
| **Consumed by** | All planning workflows; `gsd-phase-researcher`, `gsd-planner` (context); `discuss-phase` (prior decisions); `gsd-plan-checker` (project constraints). |

Includes an optional `## Business Context` section (Customer, Revenue model, Success metric, Strategy notes) for monetized or customer-facing projects — four one-line fields that connect business outcomes to requirement prioritization. It is deleted for internal tools, experiments, or meta workspaces, and reviewed at each milestone by `/gsd-complete-milestone` when present.

### `ROADMAP.md`

| | |
|---|---|
| **Purpose** | Milestone and phase listing with goals, requirement IDs, success criteria, and canonical references per phase. The single source of truth for what the project is building and in what order. |
| **Produced by** | `/gsd-new-project` (initial creation); updated by `/gsd-phase --insert` and `/gsd-complete-milestone`. |
| **Consumed by** | `/gsd-discuss-phase`, `/gsd-plan-phase`, `/gsd-execute-phase`; all orchestration commands that need phase information; `gsd-planner`, `gsd-plan-checker`, `gsd-phase-researcher`. |

### `REQUIREMENTS.md`

| | |
|---|---|
| **Purpose** | Numbered, checkable acceptance criteria for the project. Each requirement carries an ID (e.g., `AUTH-01`) that maps to roadmap phases. Marks requirements complete as phases are executed. |
| **Produced by** | `/gsd-new-project` (initial creation); requirements marked complete by `execute-phase`. |
| **Consumed by** | `gsd-planner` (plans must address all phase requirement IDs); `gsd-plan-checker` Dimension 1 (requirement coverage); `discuss-phase` (prior requirements). |

### `STATE.md`

| | |
|---|---|
| **Purpose** | Living position tracker — current phase and plan, progress metrics, accumulated decisions, session continuity notes. Read at the start of every workflow run. Updated after every significant action. |
| **Produced by** | `/gsd-new-project` (initial creation); updated continuously by all phase workflows, `/gsd-pause-work`, `/gsd-resume-work`. |
| **Consumed by** | All orchestration workflows; `/gsd-progress`; ad-hoc task execution via `/gsd-quick`; `gsd-planner` and `gsd-phase-researcher` (project decisions). |

See [STATE.md schema](state-md.md) for the full field reference.

### `config.json`

| | |
|---|---|
| **Purpose** | Workflow configuration: model profiles, research and plan-checker toggles, git branching strategy, Nyquist validation, parallelisation settings, and per-agent model overrides. |
| **Produced by** | `/gsd-new-project` (initial creation); `/gsd-settings` (interactive editing). |
| **Consumed by** | Every workflow and subagent — read at init time via `gsd-tools query config-get`. |

See [CONFIGURATION](../CONFIGURATION.md) for the complete schema.

### `MILESTONES.md` (optional)

| | |
|---|---|
| **Purpose** | Historical record of completed milestones. Populated as each milestone is closed; provides an archival snapshot of what shipped and when. |
| **Produced by** | `/gsd-complete-milestone`. |
| **Consumed by** | `/gsd-audit-milestone`; human review. |

### `DECISIONS-INDEX.md` (optional)

| | |
|---|---|
| **Purpose** | Bounded rolling summary of decisions captured in prior-phase CONTEXT.md files. When present, `discuss-phase` reads this single file instead of reading up to three prior CONTEXT.md files individually, saving context budget. |
| **Produced by** | Generated when the number of prior phases exceeds the rolling-read threshold. |
| **Consumed by** | `discuss-phase` (`load_prior_context` step). |

### `HANDOFF.json` (transient)

| | |
|---|---|
| **Purpose** | Machine-readable pause state written when work is interrupted. Contains the resume point, in-progress context, and continuation instructions. Consumed exactly once — on resume. |
| **Produced by** | `/gsd-pause-work`. |
| **Consumed by** | `/gsd-resume-work`. |

---

## Per-phase artifacts

All per-phase files live under `.planning/phases/<NN>-<slug>/` where `NN` is the zero-padded phase number and `slug` is the hyphenated phase name.

### `<NN>-CONTEXT.md`

| | |
|---|---|
| **Purpose** | Implementation decisions captured before planning begins. Contains the phase boundary (`<domain>`), locked decisions with `D-NN` identifiers (`<decisions>`), canonical document references (`<canonical_refs>`), existing code insights (`<code_context>`), specific inspirations (`<specifics>`), and deferred ideas (`<deferred>`). |
| **Produced by** | `/gsd-discuss-phase` (interactive discussion or PRD/ADR express paths). |
| **Consumed by** | `gsd-phase-researcher` (what to investigate); `gsd-planner` (locked decisions); `gsd-plan-checker` Dimension 7 (context compliance). |

See [CONTEXT.md schema](context-md.md) for the full field reference.

### `<NN>-DISCUSSION-LOG.md`

| | |
|---|---|
| **Purpose** | Human-readable audit trail of the discuss-phase session: areas discussed, options presented, selections made, deferred ideas, and items left to Claude's discretion. Not consumed by automated workflows. |
| **Produced by** | `/gsd-discuss-phase` (`git_commit` step). |
| **Consumed by** | Human review; retrospectives. |

### `<NN>-RESEARCH.md`

| | |
|---|---|
| **Purpose** | Technical research findings produced before planning. Answers "What do I need to know to plan this phase well?" — covers domain analysis, patterns, risks, an Architectural Responsibility Map, and a Validation Architecture section (used by the Nyquist gate). |
| **Produced by** | `/gsd-plan-phase` via `gsd-phase-researcher` agent. |
| **Consumed by** | `gsd-planner` (planning inputs); `gsd-plan-checker` Dimension 7c (tier compliance), Dimension 8 (Nyquist), Dimension 11 (research resolution); `gsd-pattern-mapper` (file list source). |

### `<NN>-VALIDATION.md`

| | |
|---|---|
| **Purpose** | Nyquist-inspired validation strategy derived from the `## Validation Architecture` section of RESEARCH.md. Specifies automated test coverage requirements that plans must honour. |
| **Produced by** | `/gsd-plan-phase` (Step 5.5, when `workflow.nyquist_validation` is enabled and RESEARCH.md contains a Validation Architecture section). |
| **Consumed by** | `gsd-plan-checker` Dimension 8 (Check 8e gate — must exist before Nyquist checks proceed); `gsd-verifier`. |

### `<NN>-PATTERNS.md`

| | |
|---|---|
| **Purpose** | Codebase analog map produced by `gsd-pattern-mapper`. For each file to be created or modified this phase, identifies the closest existing analog, classifies the file's role and data flow, and extracts concrete code excerpts. Guides the planner towards consistent patterns. |
| **Produced by** | `/gsd-plan-phase` via `gsd-pattern-mapper` agent (optional; skipped if `workflow.pattern_mapper: false`). |
| **Consumed by** | `gsd-planner` (pattern guidance); `gsd-plan-checker` Dimension 12 (pattern compliance). |

### `<NN>-<PP>-PLAN.md`

| | |
|---|---|
| **Purpose** | Executable plan for a single unit of work within the phase. Contains YAML frontmatter (wave, dependencies, files, requirements, `must_haves`), an objective, context references, XML-structured tasks with `<read_first>`, `<action>`, `<verify>`, and `<acceptance_criteria>` fields, and verification criteria. |
| **Produced by** | `/gsd-plan-phase` via `gsd-planner` agent. One file per plan — e.g., `03-02-PLAN.md` is Phase 3, Plan 2. |
| **Consumed by** | `/gsd-execute-phase` (executor agent reads plan and runs tasks); `gsd-plan-checker` (pre-execution quality review); `gsd-verifier` (reads `must_haves` for post-execution verification). |

See [PLAN.md schema](plan-md.md) for the full field reference.

### `<NN>-<PP>-SUMMARY.md`

| | |
|---|---|
| **Purpose** | Execution record written after a plan completes. Documents what was built, deviations from the plan, a self-check against acceptance criteria, and the dependency graph for the phase. |
| **Produced by** | `execute-phase` executor agent (written at the end of each plan's execution). |
| **Consumed by** | `/gsd-progress` (phase status); `gsd-planner` (when a subsequent plan has a genuine dependency on prior plan output); `milestone-summary`. |

### `<NN>-VERIFICATION.md`

| | |
|---|---|
| **Purpose** | Phase goal verification report. Checks `must_haves.truths`, `must_haves.artifacts`, and `must_haves.key_links` from all plans against the actual codebase after execution. Records `status: passed | gaps_found | human_needed`. |
| **Produced by** | `/gsd-verify-work` (or the verify step within `/gsd-execute-phase`). |
| **Consumed by** | `plan-phase` closed-phase gate (a `status: passed` VERIFICATION.md marks the phase `Complete` and blocks replanning without `--force`); `/gsd-progress`; human review. |

### `<NN>-UAT.md`

| | |
|---|---|
| **Purpose** | Persistent UAT session tracking. Records each test case, expected observable behaviour, result, and developer response across a live UAT session. Carries YAML frontmatter (`status`, `phase`, `source`, timestamps). |
| **Produced by** | `/gsd-audit-uat` (interactive UAT session). |
| **Consumed by** | `/gsd-audit-uat` (resume a previous UAT session). |

### `.continue-here.md`

| | |
|---|---|
| **Purpose** | Human-readable resume instructions written when work on a phase is paused. Contains context for resuming agents: critical anti-patterns, blocking issues, required reading, and the exact command to resume. |
| **Produced by** | `/gsd-pause-work`. |
| **Consumed by** | Any workflow that starts on a phase — `discuss-phase` and `plan-phase` both check for this file at entry and require the agent to demonstrate understanding of any `blocking` anti-patterns before proceeding. |

---

## Naming conventions

| Segment | Format | Example |
|---|---|---|
| Phase directory | `<NN>-<slug>` | `03-post-feed` |
| Phase-level file | `<NN>-<ARTIFACT>.md` | `03-CONTEXT.md` |
| Plan-level file | `<NN>-<PP>-<ARTIFACT>.md` | `03-02-PLAN.md` |
| `NN` | Zero-padded phase number | `03` for Phase 3 |
| `PP` | Zero-padded plan number within phase | `02` for Plan 2 |

When `project_code` is set in `config.json`, phase directories use the project code as a prefix: `CK-03-post-feed` for project code `CK`, Phase 3.

---

## Related

- [STATE.md schema](state-md.md)
- [CONTEXT.md schema](context-md.md)
- [PLAN.md schema](plan-md.md)
- [docs index](../README.md)
