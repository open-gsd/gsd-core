Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

<purpose>
Display the complete GSD Core command reference. Output ONLY the reference content. Do NOT add project-specific analysis, git status, next-step suggestions, or any commentary beyond the reference.
</purpose>

<reference>
# GSD Core Command Reference

**GSD Core** (Git. Ship. Done.) creates hierarchical project plans optimized for solo agentic development with Claude Code.

## Quick Start

1. `/gsd:new-project` — Initialize project (research, requirements, roadmap)
2. `/gsd:plan-phase 1` — Create detailed plan for first phase
3. `/gsd:execute-phase 1` — Execute the phase

Not sure where to start? `/gsd:next` reads your project state and routes you to the right next action.

### Smart Entry

**`/gsd:next`** — State-aware front door. Detects your situation via `gsd-tools smart-entry` (no-project, paused, blocked, planning, executing, needs-verify, idle, complete, …) and shows a menu with one recommended action. Launcher only; falls back to `/gsd:progress`.

Usage: `/gsd:next`

## Staying Updated

```bash
npx @opengsd/gsd-core@latest
```

## Core Workflow

```text
/gsd:new-project → /gsd:plan-phase → /gsd:execute-phase → repeat
```

### Project Initialization

**`/gsd:new-project`** — Unified flow from idea to ready-for-planning: deep questioning, optional domain research (4 parallel researchers), requirements with v1/v2/out-of-scope scoping, roadmap with phase breakdown. Creates `.planning/`: `PROJECT.md`, `config.json`, `research/`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`.

Usage: `/gsd:new-project`

**`/gsd:onboard [--fast] [--text]`** — Guides first-time onboarding for an existing codebase: detects brownfield state, routes through `/gsd:map-codebase` → `/gsd:ingest-docs` → `/gsd:new-project` in safe order, idempotent.

Usage: `/gsd:onboard`

**`/gsd:map-codebase [--fast] [--focus <area>] [--query <term>]`** — Maps an existing codebase with parallel Explore agents into `.planning/codebase/` (stack, architecture, structure, conventions, testing, integrations, concerns). `--fast` for rapid assessment, `--query` to search the intel index.

Usage: `/gsd:map-codebase`

### Phase Planning

**`/gsd:discuss-phase <number> [--chain | --analyze | --power | --assumptions] [--batch[=N]]`** — Articulate your vision for a phase before planning; creates CONTEXT.md. `--chain` chained flow, `--analyze` assumption analysis, `--power` extended questions, `--assumptions` surfaces implementation assumptions non-interactively, `--batch` groups 2-5 questions per turn.

Usage: `/gsd:discuss-phase 2`
Usage: `/gsd:discuss-phase 2 --batch=3`

**`/gsd:plan-phase <number> [--research] [--skip-research] [--research-phase <N>] [--view] [--gaps] [--skip-verify] [--skip-ui] [--prd <file>] [--ingest <path-or-glob>] [--ingest-format <auto|nygard|madr|narrative>] [--reviews] [--text] [--bounce] [--skip-bounce] [--chunked] [--tdd] [--mvp] [--granularity <coarse|standard|fine>] [--no-tracer] [--no-reversibility-gates]`** — Creates `.planning/phases/XX-phase-name/XX-YY-PLAN.md` with concrete tasks, verification criteria, and success measures (multiple plans per phase supported).

Key flags: `--research-phase <N>` runs research only and writes `RESEARCH.md` then exits (replaces the deleted `gsd-research-phase`; `--research` forces refresh, `--view` prints existing without spawning). `--gaps` closes gaps from a prior plan-check. `--ingest`/`--ingest-format` pre-ingest external ADRs/PRDs/SPECs (see PRD Express Path). `--bounce`/`--skip-bounce` toggle the optional external refinement pass (`workflow.plan_bounce`). `--chunked` splits planning into short, individually-committed passes for crash resilience (`workflow.plan_chunked`), resumable. `--tdd` tests-before-code order. `--mvp` adds user story + Walking Skeleton (see `/gsd:mvp-phase`). `--granularity` overrides resolved plan granularity. `--no-tracer` opts out of tracer-first ordering. `--no-reversibility-gates` suppresses the one-way-door checkpoint for unattended runs.

Usage: `/gsd:plan-phase 1`
Result: Creates `.planning/phases/01-foundation/01-01-PLAN.md`

**PRD Express Path:** Pass `--prd path/to/requirements.md` to skip discuss-phase — your PRD becomes locked decisions in CONTEXT.md.

### Execution

**`/gsd:execute-phase <phase-number> [--wave N] [--gaps-only] [--tdd]`** — Groups plans by wave (frontmatter), executes sequentially with parallel plans per wave via Task tool, verifies phase goal, updates REQUIREMENTS/ROADMAP/STATE. `--wave N` runs only wave N; `--gaps-only` re-runs verifier-flagged plans; `--tdd` enforces test-driven order.

Usage: `/gsd:execute-phase 5`
Usage: `/gsd:execute-phase 5 --wave 2`

### Smart Router

**`/gsd:progress --do "<description>"`** — Routes freeform text to the best-matching GSD command; asks you to pick between top matches on ambiguity. Never does the work itself.

Usage: `/gsd:progress --do "fix the login button"`

### Quick Mode

**`/gsd:quick [--full] [--validate] [--discuss] [--research]`** — Small ad-hoc tasks in `.planning/quick/` (updates STATE.md, not ROADMAP.md); spawns planner+executor only by default. `--full` = discuss+research+plan-check+verify; `--validate` = plan-check + post-execution verify; `--discuss`/`--research` add one step each; flags compose.

Usage: `/gsd:quick`
Result: Creates `.planning/quick/NNN-slug/PLAN.md`, `.planning/quick/NNN-slug/NNN-slug-SUMMARY.md`

---

**`/gsd:quick-batch [--file <path>] [--jobs auto|N] [--validate] [--research] [--resume <batch-id>] [task list]`** — Batches several quick-shaped tasks (inline or `--file`); one coordinator plans/dispatches/merges. `--jobs` caps concurrency, `--resume` dispatches only eligible items; `--discuss`/`--full` are rejected.

Usage: `/gsd:quick-batch --jobs 3 --validate`
Result: Per-item artifacts under `.planning/quick/`; batch state in `.planning/quick-batches/<batch-id>/BATCH.json`

---

**`/gsd:fast [description]`** — Trivial task inline, no subagent, no planning files: typo fixes, config changes, ≤3 file edits (redirects to `/gsd:quick` above that). Atomic commit, logs to STATE.md.

Usage: `/gsd:fast "fix the typo in README"`

### Roadmap Management

**`/gsd:phase <description>`** — Appends a new phase (next sequential number) to ROADMAP.md.

Usage: `/gsd:phase "Add admin dashboard"`

**`/gsd:phase --insert <after> <description>`** — Inserts a decimal phase (e.g. 7.1) between existing phases for discovered mid-milestone work.

Usage: `/gsd:phase --insert 7 "Fix critical auth bug"`
Result: Creates Phase 7.1

**`/gsd:phase --remove <number>`** — Deletes a future (unstarted) phase and renumbers subsequent phases; git commit preserves history.

Usage: `/gsd:phase --remove 17`
Result: Phase 17 deleted, phases 18-20 become 17-19

**`/gsd:phase --edit <number> [--force]`** — Edits title/description/requirements/dependencies in place; `--force` allows editing already-started phases.

### Milestone Management

**`/gsd:new-milestone <name>`** — Mirrors `/gsd:new-project`'s flow for brownfield (existing PROJECT.md): questioning, optional research, requirements, roadmap. `--reset-phase-numbers` restarts at Phase 1 (archives old dirs first); `--ws <name>` scopes to a workstream, skipping the shared PROJECT.md write.

Usage: `/gsd:new-milestone "v2.0 Features"`

**`/gsd:complete-milestone <version>`** — Archives to MILESTONES.md + milestones/ dir, tags the release, preps workspace for next version.

Usage: `/gsd:complete-milestone 1.0.0`

### Progress Tracking

**`/gsd:progress [--next | --forensic | --do "<description>"]`** — Progress bar, SUMMARY recap, current position, key decisions, offers to execute/create next plan, detects 100% completion.

Modes: default (report+routing) · `--next` (auto-advance; `--force` bypasses safety gates) · `--next --auto` (chains steps until milestone completion or a blocking decision) · `--next --converge` (routes planning through `/gsd:plan-review-convergence`, requires `workflow.plan_review_convergence`; reviewer flags and `--max-cycles` forward) · `--forensic` (appends a 6-check integrity audit) · `--do "<text>"` (smart router, see above).

Usage: `/gsd:progress`
Usage: `/gsd:progress --next --auto`

### Session Management

**`/gsd:resume-work`** — Reads STATE.md, shows position and recent progress, offers next actions.

Usage: `/gsd:resume-work`

**`/gsd:pause-work [--report]`** — Creates a `.continue-here` handoff, updates STATE.md's session-continuity section. `--report` also writes a post-session summary to `.planning/reports/`.

Usage: `/gsd:pause-work`

### Debugging

**`/gsd:debug [issue description] [--diagnose]`** — Adaptive-question symptom gathering, `.planning/debug/[slug].md` tracking, scientific-method investigation, survives `/clear` (resume with no args), archives resolved issues. `--diagnose` runs a one-shot pass without a persistent session.

Usage: `/gsd:debug "login button doesn't work"`

### Spiking & Sketching

**`/gsd:spike [idea] [--quick]`** — Decomposes into 2-5 risk-ordered Given/When/Then experiments, builds minimum code, captures VALIDATED/INVALIDATED/PARTIAL, saves to `.planning/spikes/` with MANIFEST.md. Works in any repo, no `/gsd:new-project` needed. `--quick` skips decomposition.

Usage: `/gsd:spike "can we stream LLM output over WebSockets?"`

**`/gsd:sketch [idea] [--quick]`** — Conversational mood intake, 2-3 tabbed HTML variants per sketch, shared CSS theme system, saves to `.planning/sketches/` with MANIFEST.md. `--quick` skips mood intake.

Usage: `/gsd:sketch "dashboard layout for the admin panel"`

**`/gsd:spike --wrap-up`** — Curates spikes one-at-a-time (include/exclude/partial/UAT), generates a project skill under `./.claude/skills/spike-findings-[project]/`, writes `.planning/spikes/WRAP-UP-SUMMARY.md`, adds a CLAUDE.md auto-load line.

Usage: `/gsd:spike --wrap-up`

**`/gsd:sketch --wrap-up`** — Same curation flow for sketches, generating `./.claude/skills/sketch-findings-[project]/` with design decisions/CSS/HTML structures.

Usage: `/gsd:sketch --wrap-up`

### Capturing Ideas, Notes, and Todos

**`/gsd:capture [description]`** — Extracts context from conversation (or uses the given text), creates a todo in `.planning/todos/pending/`, infers area, checks duplicates, updates STATE.md count.

Usage: `/gsd:capture Add auth token refresh`

**`/gsd:capture --note <text>`** — Zero-friction timestamped note to `.planning/notes/` (or `~/.claude/notes/` globally). Subcommands: append (default), list, promote (note → todo). Works without a project.

Usage: `/gsd:capture --note refactor the hook system`
Usage: `/gsd:capture --note promote 3`

**`/gsd:capture --list [area]`** — Lists pending todos (optional area filter), loads full context for the one you pick, routes to work-now/add-to-phase/brainstorm, moves it to completed/ on start.

Usage: `/gsd:capture --list api`

**`/gsd:capture --list-seeds [status]`** — Read-only listing of captured seeds (ID, status, scope, trigger, title); optional status filter. Enrich via `/gsd:capture --seed --enrich SEED-YYMMDD-XXX`.

Usage: `/gsd:capture --list-seeds dormant`

### User Acceptance Testing

**`/gsd:verify-work [phase]`** — Extracts testable deliverables from SUMMARY.md, presents tests one at a time (yes/no), auto-diagnoses failures into fix plans, ready for re-execution.

Usage: `/gsd:verify-work 3`

### Ship Work

**`/gsd:ship [phase]`** — Pushes branch, opens a PR with a body from SUMMARY/VERIFICATION/REQUIREMENTS, optionally requests review, updates STATE.md. Requires a verified phase and authenticated `gh`.

Usage: `/gsd:ship 4` or `/gsd:ship 4 --draft`

---

**`/gsd:review --phase N [--claude] [--codex] [--coderabbit] [--opencode] [--qwen] [--cursor] [--agy] [--all]`** — Detects available external AI CLIs, each independently reviews the phase's plans with the same structured prompt (CodeRabbit reviews the live diff, up to ~5 min), produces REVIEWS.md with consensus. Feed back via `/gsd:plan-phase N --reviews`.

Usage: `/gsd:review --phase 3 --all`

---

**`/gsd:pr-branch [target]`** — Classifies commits (code-only/planning-only/mixed), cherry-picks code onto a clean branch so reviewers see no `.planning/` artifacts.

Usage: `/gsd:pr-branch` or `/gsd:pr-branch main`

---

**`/gsd:capture --seed [idea]`** — Captures a forward-looking idea with WHY/WHEN-to-surface trigger conditions; auto-surfaces during `/gsd:new-milestone` when triggers match.

Usage: `/gsd:capture --seed "add real-time notifications when we build the events system"`

**`/gsd:capture --backlog [description]`** — Adds an idea to the 999.x backlog without committing to the current milestone; promote later via `/gsd:review-backlog`.

Usage: `/gsd:capture --backlog "real-time notifications when events ship"`

---

**`/gsd:audit-uat`** — Cross-phase audit of all outstanding UAT/verification items (pending, skipped, blocked, human_needed), cross-references the codebase for stale docs, produces a prioritized test plan. Run before a new milestone.

Usage: `/gsd:audit-uat`

### Milestone Auditing

**`/gsd:audit-milestone [version]`** — Reads all phase VERIFICATION.md files, checks requirements coverage, spawns an integration checker for cross-phase wiring, creates MILESTONE-AUDIT.md.

Usage: `/gsd:audit-milestone`

### Configuration

**`/gsd:settings`** — Interactively toggles researcher/plan-checker/verifier agents and the model profile (quality/balanced/budget/inherit); updates `.planning/config.json`.

Usage: `/gsd:settings`

**`/gsd:config [--profile <profile> | --advanced | --integrations]`** — `--profile` quick-switches model profile (`quality` = Opus everywhere but verification, `balanced` = Opus planning/Sonnet execution (default), `budget` = Sonnet writing/Haiku research-verification, `inherit` = current session model). `--advanced` = plan bounce, timeouts, branch templates, cross-AI execution. `--integrations` = third-party API keys, code-review CLI routing, agent-skill injection.

Usage: `/gsd:config --profile budget`

**`/gsd:surface [list|status|profile <name>|disable <cluster>|enable <cluster>|reset]`** — Toggles which skills are surfaced without reinstalling: `list`/`status` show enabled/disabled + token cost, `profile <name>` switches base profile (`core`/`standard`/`full`), `disable`/`enable` a cluster, `reset` returns to install-time profile.

Usage: `/gsd:surface profile standard`

### Utility Commands

**`/gsd:cleanup`** — Dry-run then moves completed-milestone phase dirs from `.planning/phases/` to `.planning/milestones/v{X.Y}-phases/`.

Usage: `/gsd:cleanup`

**`/gsd:help [--brief | --full | <topic> | --brief <topic>]`** — `--brief` = ~10-line refresher; no flag = one-page newcomer tour; `--full` = this complete reference; `<topic>` = matching section only (e.g. `/gsd:help debug`); `--brief <topic>` = compact scoped lookup. Every topic output starts with a `**Topic:** \`<alias>\` → \`<heading>\` *(scope: full | compact)*` preamble. See `gsd-core/workflows/help/modes/topic.md` for the alias table.

Usage: `/gsd:help debug`
Usage: `/gsd:help --brief debug`

**`/gsd:update [--sync] [--reapply] [--next | --rc]`** — Shows installed-vs-latest, changelog since your version, breaking changes, confirms before installing. `--sync` syncs managed skills across runtime roots; `--reapply` reapplies local modifications post-update; `--next`/`--rc` installs from the `@next` RC dist-tag (ADR #660) instead of `@latest`.

Usage: `/gsd:update`

## Additional Commands

Every command below is also a live `/gsd-*` slash command, grouped by purpose.

### Discovery & Specification

- **`/gsd:explore`** — Socratic ideation and idea routing before committing to plans.
- **`/gsd:spec-phase <phase> [--auto] [--text]`** — Clarify WHAT a phase delivers with ambiguity scoring; produces SPEC.md before discuss-phase.
- **`/gsd:ai-integration-phase [phase]`** — Generate an AI-SPEC.md design contract for phases building AI systems.
- **`/gsd:ui-phase [phase]`** — Generate UI design contract (UI-SPEC.md) for frontend phases.
- **`/gsd:import --from <filepath> | --from-gsd2`** — Ingest external plans with conflict detection, or reverse-migrate a GSD-2 project to v1 format.
- **`/gsd:ingest-docs [path] [--mode new|merge] [--manifest <file>] [--resolve auto|interactive]`** — Bootstrap or merge `.planning/` from existing ADRs/PRDs/SPECs/docs.

### Planning & Execution

- **`/gsd:mvp-phase <phase-number>`** — Plans a phase as a vertical MVP slice (user story + SPIDR splitting) before handoff to plan-phase; same end-state as `/gsd:plan-phase --mvp` with a guided intro.
- **`/gsd:ultraplan-phase [phase]`** — [BETA] Offload plan phase to Claude Code's ultraplan cloud; review in browser, import back.
- **`/gsd:plan-review-convergence <phase> [--claude] [--codex] [--coderabbit] [--opencode] [--qwen] [--cursor] [--agy/--antigravity] [--ollama] [--lm-studio] [--llama-cpp] [--kimi-code] [--all] [--text] [--ws <name>] [--max-cycles N]`** — Cross-AI convergence loop: replan with review feedback until no HIGH concerns remain (cloud and local-model reviewers).
- **`/gsd:autonomous [--from N] [--to N] [--only N] [--interactive] [--converge]`** — Runs all remaining phases unattended: discuss → plan → execute per phase; `--converge`/`--cross-ai` routes planning through convergence.

### Quality, Review & Verification

- **`/gsd:code-review <phase> [--depth=quick|standard|deep] [--files file1,file2,...] [--fix [--all] [--auto]]`** — Reviews phase-changed source for bugs, security, quality.
- **`/gsd:secure-phase [phase]`** — Retroactively verifies threat mitigations for a completed phase.
- **`/gsd:validate-phase [phase]`** — Retroactively audits and fills Nyquist validation gaps.
- **`/gsd:ui-review [phase]`** — Retroactive 6-pillar visual audit of implemented frontend code.
- **`/gsd:eval-review [phase]`** — Audits an executed AI phase's evaluation coverage; produces EVAL-REVIEW.md.
- **`/gsd:audit-fix --source <audit-uat> [--severity medium|high|all] [--max N] [--dry-run]`** — Autonomous audit-to-fix: find, classify, fix, test, commit.
- **`/gsd:add-tests <phase> [additional instructions]`** — Generates tests for a completed phase from UAT criteria and implementation.

### Diagnostics & Maintenance

- **`/gsd:health [--repair] [--context]`** — Diagnoses planning-directory health, optionally repairs.
- **`/gsd:forensics [problem description]`** — Post-mortem investigation for failed GSD workflows.
- **`/gsd:undo --last N | --phase NN | --plan NN-MM`** — Safe git revert using the phase manifest with dependency checks.
- **`/gsd:docs-update [--force] [--verify-only]`** — Generates/updates docs verified against the codebase.
- **`/gsd:extract-learnings <phase>`** — Extracts decisions, lessons, patterns, surprises from phase artifacts.

### Knowledge & Context

- **`/gsd:graphify [build|query <term>|status|diff]`** — Builds/queries/inspects the project knowledge graph in `.planning/graphs/`.
- **`/gsd:mempalace-recall`** — Recalls prior decisions/patterns/surprises from MemPalace before planning.
- **`/gsd:mempalace-capture [artifact-type]`** — Files a phase artifact into MemPalace, mirrors decisions into its temporal KG.
- **`/gsd:thread [list [--open|--resolved] | close <slug> | status <slug> | name | description]`** — Manages persistent context threads across sessions.
- **`/gsd:profile-user [--questionnaire] [--refresh]`** — Generates a developer behavioral profile + Claude-discoverable artifacts.
- **`/gsd:stats`** — Project statistics: phases, plans, requirements, git metrics, timeline.

### Workflow & Orchestration

- **`/gsd:manager [--analyze-deps]`** — Interactive command center for multiple phases from one terminal; `--analyze-deps` scans dependency relationships before parallel execution.
- **`/gsd:workspace [--new | --list | --remove] [name]`** — Creates/lists/removes isolated GSD workspace environments.
- **`/gsd:workstreams`** — List, create, switch, status, progress, complete, and resume parallel workstreams.
- **`/gsd:review-backlog`** — Reviews and promotes backlog items to the active milestone.
- **`/gsd:milestone-summary [version]`** — Comprehensive project summary from milestone artifacts, for onboarding/review.

### Repository Integration

- **`/gsd:inbox [--issues] [--prs] [--label] [--close-incomplete] [--repo owner/repo]`** — Triages open GitHub issues/PRs against project templates and contribution guidelines.

### Namespace Routers (model-facing meta-skills)

Six skills for two-stage hierarchical routing across 60+ skills; invoke directly to browse a category interactively:

- **`/gsd-context`** — Codebase intelligence (map, graphify, docs, learnings, mempalace).
- **`/gsd-ideate`** — Exploration/capture (explore, sketch, spike, spec, capture).
- **`/gsd-manage`** — Configuration/workspace (workstreams, thread, update, ship, inbox).
- **`/gsd-project`** — Project-lifecycle (milestones, audits, summary).
- **`/gsd-quality`** — Quality gates (code review, debug, audit, security, eval, ui).
- **`/gsd-workflow`** — Phase pipeline (discuss, plan, execute, verify, phase, progress).

## Files & Structure

```text
.planning/
├── PROJECT.md            # Project vision
├── ROADMAP.md            # Current phase breakdown
├── STATE.md              # Project memory & context
├── RETROSPECTIVE.md      # Living retrospective (updated per milestone)
├── config.json           # Workflow mode & gates
├── todos/                # Captured ideas and tasks (pending/, completed/)
├── spikes/               # Spike experiments — MANIFEST.md + NNN-name/ dirs
├── sketches/             # Design sketches — MANIFEST.md, themes/, NNN-name/ dirs
├── debug/                # Active debug sessions (resolved/ archive)
├── milestones/           # Archived roadmap/requirements snapshots + v{X.Y}-phases/
├── codebase/             # Codebase map (brownfield): STACK/ARCHITECTURE/STRUCTURE/
│                         # CONVENTIONS/TESTING/INTEGRATIONS/CONCERNS.md
└── phases/               # 01-foundation/01-01-PLAN.md + -SUMMARY.md, etc.
```

## Workflow Modes

Set during `/gsd:new-project`, changeable anytime in `.planning/config.json`:

- **Interactive** — confirms each major decision, pauses at checkpoints, more guidance.
- **YOLO** — auto-approves most decisions, executes without confirmation, stops only for critical checkpoints.

## Planning Configuration

`.planning/config.json`:

- **`planning.commit_docs`** (default `true`) — `false` keeps planning artifacts local-only (add `.planning/` to `.gitignore`); useful for OSS/client projects wanting private planning.
- **`planning.search_gitignored`** (default `false`) — `true` adds `--no-ignore` to broad ripgrep searches when `.planning/` is gitignored.

```json
{
  "planning": {
    "commit_docs": false,
    "search_gitignored": true
  }
}
```

## Common Workflows

**New project:** `/gsd:new-project` → `/clear` → `/gsd:plan-phase 1` → `/clear` → `/gsd:execute-phase 1`

**Resuming:** `/gsd:progress`

**Urgent mid-milestone work:** `/gsd:phase --insert 5 "Critical security fix"` → `/gsd:plan-phase 5.1` → `/gsd:execute-phase 5.1`

**Completing a milestone:** `/gsd:complete-milestone 1.0.0` → `/clear` → `/gsd:new-milestone`

**Capturing ideas:** `/gsd:capture` (from context) · `/gsd:capture --note ...` (quick note) · `/gsd:capture --seed "..."` (forward-looking) · `/gsd:capture --list` (review)

**Debugging:** `/gsd:debug "symptom"` → (investigate, context fills) → `/clear` → `/gsd:debug` (resumes)

## Getting Help

- Read `.planning/PROJECT.md` for project vision
- Read `.planning/STATE.md` for current context
- Check `.planning/ROADMAP.md` for phase status
- Run `/gsd:progress` to check where you're up to
</reference>
