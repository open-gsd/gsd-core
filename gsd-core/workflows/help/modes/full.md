<purpose>
Display the complete GSD Core command reference. Output ONLY the reference content. Do NOT add project-specific analysis, git status, next-step suggestions, or any commentary beyond the reference.
</purpose>

<reference>
# GSD Core Command Reference

**GSD Core** (Git. Ship. Done.) creates hierarchical project plans optimized for solo agentic development with Claude Code.

## Quick Start

1. `/gsd:new-project` - Initialize project (includes research, requirements, roadmap)
2. `/gsd:plan-phase 1` - Create detailed plan for first phase
3. `/gsd:execute-phase 1` - Execute the phase

Not sure where to start? `/gsd:next` reads your project state and routes you to the right next action.

### Smart Entry

**`/gsd:next`**
The state-aware front door. Detects your current situation and presents a short menu of the right next actions.

- Reads `.planning/STATE.md`, git state, and verification signals via `gsd-tools smart-entry`
- Classifies your situation (no-project, paused, blocked, planning, executing, needs-verify, idle, complete, …)
- Shows a situation-appropriate menu with one recommended action, then dispatches
- Launcher/router only — it never does the work itself; falls back to `/gsd:progress` if detection is unavailable

Usage: `/gsd:next`

## Staying Updated

GSD evolves fast. Update periodically:

```bash
npx @opengsd/gsd-core@latest
```

## Core Workflow

```text
/gsd:new-project → /gsd:plan-phase → /gsd:execute-phase → repeat
```

### Project Initialization

**`/gsd:new-project`**
Initialize new project through unified flow.

One command takes you from idea to ready-for-planning:
- Deep questioning to understand what you're building
- Optional domain research (spawns 4 parallel researcher agents)
- Requirements definition with v1/v2/out-of-scope scoping
- Roadmap creation with phase breakdown and success criteria

Creates all `.planning/` artifacts:
- `PROJECT.md` — vision and requirements
- `config.json` — workflow mode (interactive/yolo)
- `research/` — domain research (if selected)
- `REQUIREMENTS.md` — scoped requirements with REQ-IDs
- `ROADMAP.md` — phases mapped to requirements
- `STATE.md` — project memory

Usage: `/gsd:new-project`

**`/gsd:onboard [--fast] [--text]`**
Guide first-time onboarding for an existing codebase.

- Detects brownfield code, existing planning docs, and partial `.planning/` state
- Routes through `/gsd:map-codebase`, `/gsd:ingest-docs`, and `/gsd:new-project` in the safe order
- Creates `.planning/onboarding/SUMMARY.md` after project setup
- Idempotent: confirms existing artifacts and does not overwrite planning silently

Usage: `/gsd:onboard`

**`/gsd:map-codebase [--fast] [--focus <area>] [--query <term>]`**
Map an existing codebase for brownfield projects.

- `--fast` — rapid lightweight assessment (replaces the former `gsd-scan`)
- `--focus <area>` — scope the map to a specific area
- `--query <term>` — query the codebase intelligence index in `.planning/intel/` (replaces the former `gsd-intel`)

- Analyzes codebase with parallel Explore agents
- Creates `.planning/codebase/` with 7 focused documents
- Covers stack, architecture, structure, conventions, testing, integrations, concerns
- Usually reached through `/gsd:onboard` for first-time existing-codebase setup; run directly to refresh or focus a map

Usage: `/gsd:map-codebase`

### Phase Planning

**`/gsd:discuss-phase <number> [--chain | --analyze | --power | --assumptions] [--batch[=N]]`**
Help articulate your vision for a phase before planning.

- `--chain` — chained-prompt discuss flow
- `--analyze` — deep assumption analysis pass
- `--power` — power-user mode with extended question set
- `--assumptions` — surface Claude's implementation assumptions about the phase without an interactive session

- Captures how you imagine this phase working
- Creates CONTEXT.md with your vision, essentials, and boundaries
- Use when you have ideas about how something should look/feel
- Optional `--batch` asks 2-5 related questions at a time instead of one-by-one

Usage: `/gsd:discuss-phase 2`
Usage: `/gsd:discuss-phase 2 --batch`
Usage: `/gsd:discuss-phase 2 --batch=3`

**`/gsd:plan-phase <number> [--research] [--skip-research] [--research-phase <N>] [--view] [--gaps] [--skip-verify] [--prd <file>] [--ingest <path-or-glob>] [--ingest-format <auto|nygard|madr|narrative>] [--reviews] [--text] [--tdd] [--mvp]`**
Create detailed execution plan for a specific phase.

- `--skip-research` — bypass the research subagent
- `--research-phase <N>` — research-only mode. Spawns the research agent for phase `<N>`, writes `RESEARCH.md`, then exits before the planner runs. Useful for cross-phase research, doc review before committing to a planning approach, and correction-without-replanning loops. Replaces the deleted `gsd-research-phase` standalone command (#3042).
  - Modifiers: `--research` forces refresh (re-spawn researcher). `--view` prints existing `RESEARCH.md` to stdout without spawning. With neither, auto-uses an existing `RESEARCH.md` (one-line notice, then clean exit).
- `--gaps` — focus only on closing gaps from a prior plan-check
- `--skip-verify` — skip the post-plan verifier loop
- `--ingest <path-or-glob>` — pre-ingest external ADRs/PRDs/SPECs before planning (see *PRD Express Path* below)
- `--ingest-format <auto|nygard|madr|narrative>` — hint the ADR ingester's parser when `--ingest` is set; defaults to `auto`
- `--tdd` — plan in test-driven order (tests before code)
- `--mvp` — vertical-slice MVP planning mode (see also `/gsd:mvp-phase`)

- Generates `.planning/phases/XX-phase-name/XX-YY-PLAN.md`
- Breaks phase into concrete, actionable tasks
- Includes verification criteria and success measures
- Multiple plans per phase supported (XX-01, XX-02, etc.)

Usage: `/gsd:plan-phase 1`
Usage: `/gsd:plan-phase --research-phase 2` — research only on phase 2 (auto-uses existing `RESEARCH.md`, no prompt)
Usage: `/gsd:plan-phase --research-phase 2 --view` — print existing `RESEARCH.md`, no spawn
Usage: `/gsd:plan-phase --research-phase 2 --research` — force-refresh, no prompt
Result: Creates `.planning/phases/01-foundation/01-01-PLAN.md`

**PRD Express Path:** Pass `--prd path/to/requirements.md` to skip discuss-phase entirely. Your PRD becomes locked decisions in CONTEXT.md. Useful when you already have clear acceptance criteria.

### Execution

**`/gsd:execute-phase <phase-number> [--wave N] [--gaps-only] [--tdd]`**
Execute all plans in a phase, or run a specific wave.

- `--wave N` — execute only wave N (see *Plans within each wave* below)
- `--gaps-only` — re-run only plans flagged as gaps by a prior verifier
- `--tdd` — enforce test-driven order during execution

- Groups plans by wave (from frontmatter), executes waves sequentially
- Plans within each wave run in parallel via Task tool
- Optional `--wave N` flag executes only Wave `N` and stops unless the phase is now fully complete
- Verifies phase goal after all plans complete
- Updates REQUIREMENTS.md, ROADMAP.md, STATE.md

Usage: `/gsd:execute-phase 5`
Usage: `/gsd:execute-phase 5 --wave 2`

### Smart Router

**`/gsd:progress --do "<description>"`**
Route freeform text to the right GSD command automatically.

- Analyzes natural language input to find the best matching GSD command
- Acts as a dispatcher — never does the work itself
- Resolves ambiguity by asking you to pick between top matches
- Use when you know what you want but don't know which `/gsd-*` command to run

Usage: `/gsd:progress --do "fix the login button"`
Usage: `/gsd:progress --do "refactor the auth system"`
Usage: `/gsd:progress --do "I want to start a new milestone"`

### Quick Mode

**`/gsd:quick [--full] [--validate] [--discuss] [--research]`**
Execute small, ad-hoc tasks with GSD guarantees but skip optional agents.

Quick mode uses the same system with a shorter path:
- Spawns planner + executor (skips researcher, checker, verifier by default)
- Quick tasks live in `.planning/quick/` separate from planned phases
- Updates STATE.md tracking (not ROADMAP.md)

Flags enable additional quality steps:
- `--full` — Complete quality pipeline: discussion + research + plan-checking + verification
- `--validate` — Plan-checking (max 2 iterations) and post-execution verification only
- `--discuss` — Lightweight discussion to surface gray areas before planning
- `--research` — Focused research agent investigates approaches before planning

Granular flags are composable: `--discuss --research --validate` gives the same as `--full`.

Usage: `/gsd:quick`
Usage: `/gsd:quick --full`
Usage: `/gsd:quick --research --validate`
Result: Creates `.planning/quick/NNN-slug/PLAN.md`, `.planning/quick/NNN-slug/NNN-slug-SUMMARY.md`

---

**`/gsd:fast [description]`**
Execute a trivial task inline — no subagents, no planning files, no overhead.

For tasks too small to justify planning: typo fixes, config changes, forgotten commits, simple additions. Runs in the current context, makes the change, commits, and logs to STATE.md.

- No PLAN.md or SUMMARY.md created
- No subagent spawned (runs inline)
- ≤ 3 file edits — redirects to `/gsd:quick` if task is non-trivial
- Atomic commit with conventional message

Usage: `/gsd:fast "fix the typo in README"`
Usage: `/gsd:fast "add .env to gitignore"`

### Roadmap Management

**`/gsd:phase <description>`**
Add new phase to end of current milestone.

- Appends to ROADMAP.md
- Uses next sequential number
- Updates phase directory structure

Usage: `/gsd:phase "Add admin dashboard"`

**`/gsd:phase --insert <after> <description>`**
Insert urgent work as decimal phase between existing phases.

- Creates intermediate phase (e.g., 7.1 between 7 and 8)
- Useful for discovered work that must happen mid-milestone
- Maintains phase ordering

Usage: `/gsd:phase --insert 7 "Fix critical auth bug"`
Result: Creates Phase 7.1

**`/gsd:phase --remove <number>`**
Remove a future phase and renumber subsequent phases.

- Deletes phase directory and all references
- Renumbers all subsequent phases to close the gap
- Only works on future (unstarted) phases
- Git commit preserves historical record

Usage: `/gsd:phase --remove 17`
Result: Phase 17 deleted, phases 18-20 become 17-19

**`/gsd:phase --edit <number> [--force]`**
Edit any field of an existing roadmap phase in place, preserving number and position.

- Updates title, description, requirements, dependencies in `ROADMAP.md`
- `--force` allows editing already-started phases (use with caution)

### Milestone Management

**`/gsd:new-milestone <name>`**
Start a new milestone through unified flow.

- Deep questioning to understand what you're building next
- Optional domain research (spawns 4 parallel researcher agents)
- Requirements definition with scoping
- Roadmap creation with phase breakdown
- Optional `--reset-phase-numbers` flag restarts numbering at Phase 1 and archives old phase dirs first for safety

Mirrors `/gsd:new-project` flow for brownfield projects (existing PROJECT.md).

Usage: `/gsd:new-milestone "v2.0 Features"`
Usage: `/gsd:new-milestone --reset-phase-numbers "v2.0 Features"`

**`/gsd:complete-milestone <version>`**
Archive completed milestone and prepare for next version.

- Creates MILESTONES.md entry with stats
- Archives full details to milestones/ directory
- Creates git tag for the release
- Prepares workspace for next version

Usage: `/gsd:complete-milestone 1.0.0`

### Progress Tracking

**`/gsd:progress [--next | --forensic | --do "<description>"]`**
Check project status and intelligently route to next action.

- Shows visual progress bar and completion percentage
- Summarizes recent work from SUMMARY files
- Displays current position and what's next
- Lists key decisions and open issues
- Offers to execute next plan or create it if missing
- Detects 100% milestone completion

Modes:
- **default** — progress report + intelligent routing
- **`--next`** — auto-advance to the next logical step (use `--next --force` to bypass safety gates)
- **`--next --auto`** — like `--next`, but chains steps automatically until milestone completion or a blocking decision
- **`--next --converge`** — when the next action is planning, route it through `/gsd:plan-review-convergence` instead of `/gsd:plan-phase`; requires `workflow.plan_review_convergence=true`. `--cross-ai` is an alias. Reviewer flags (`--codex`, `--gemini`, `--claude`, `--opencode`, `--ollama`, `--lm-studio`, `--llama-cpp`, `--all`) and `--max-cycles N` forward to the convergence loop.
- **`--forensic`** — append a 6-check integrity audit after the progress report
- **`--do "<text>"`** — smart router: dispatch freeform intent to the matching `/gsd-*` command (see *Smart Router* above)

Usage: `/gsd:progress`
Usage: `/gsd:progress --next`
Usage: `/gsd:progress --next --auto`
Usage: `/gsd:progress --next --auto --converge`
Usage: `/gsd:progress --forensic`

### Session Management

**`/gsd:resume-work`**
Resume work from previous session with full context restoration.

- Reads STATE.md for project context
- Shows current position and recent progress
- Offers next actions based on project state

Usage: `/gsd:resume-work`

**`/gsd:pause-work [--report]`**
Create context handoff when pausing work mid-phase.

- `--report` — generate a post-session summary in `.planning/reports/` capturing commits, file changes, and phase progress
- Creates .continue-here file with current state
- Updates STATE.md session continuity section
- Captures in-progress work context

Usage: `/gsd:pause-work`

### Debugging

**`/gsd:debug [issue description] [--diagnose]`**
Systematic debugging with persistent state across context resets.

- `--diagnose` — run a one-shot diagnostic pass without opening a persistent debug session

- Gathers symptoms through adaptive questioning
- Creates `.planning/debug/[slug].md` to track investigation
- Investigates using scientific method (evidence → hypothesis → test)
- Survives `/clear` — run `/gsd:debug` with no args to resume
- Archives resolved issues to `.planning/debug/resolved/`

Usage: `/gsd:debug "login button doesn't work"`
Usage: `/gsd:debug` (resume active session)

### Spiking & Sketching

**`/gsd:spike [idea] [--quick]`**
Rapidly spike an idea with throwaway experiments to validate feasibility.

- Decomposes idea into 2-5 focused experiments (risk-ordered)
- Each spike answers one specific Given/When/Then question
- Builds minimum code, runs it, captures verdict (VALIDATED/INVALIDATED/PARTIAL)
- Saves to `.planning/spikes/` with MANIFEST.md tracking
- Does not require `/gsd:new-project` — works in any repo
- `--quick` skips decomposition, builds immediately

Usage: `/gsd:spike "can we stream LLM output over WebSockets?"`
Usage: `/gsd:spike --quick "test if pdfjs extracts tables"`

**`/gsd:sketch [idea] [--quick]`**
Rapidly sketch UI/design ideas using throwaway HTML mockups with multi-variant exploration.

- Conversational mood/direction intake before building
- Each sketch produces 2-3 variants as tabbed HTML pages
- User compares variants, cherry-picks elements, iterates
- Shared CSS theme system compounds across sketches
- Saves to `.planning/sketches/` with MANIFEST.md tracking
- Does not require `/gsd:new-project` — works in any repo
- `--quick` skips mood intake, jumps to building

Usage: `/gsd:sketch "dashboard layout for the admin panel"`
Usage: `/gsd:sketch --quick "form card grouping"`

**`/gsd:spike --wrap-up`**
Package spike findings into a persistent project skill.

- Curates each spike one-at-a-time (include/exclude/partial/UAT)
- Groups findings by feature area
- Generates `./.claude/skills/spike-findings-[project]/` with references and sources
- Writes summary to `.planning/spikes/WRAP-UP-SUMMARY.md`
- Adds auto-load routing line to project CLAUDE.md

Usage: `/gsd:spike --wrap-up`

**`/gsd:sketch --wrap-up`**
Package sketch design findings into a persistent project skill.

- Curates each sketch one-at-a-time (include/exclude/partial/revisit)
- Groups findings by design area
- Generates `./.claude/skills/sketch-findings-[project]/` with design decisions, CSS patterns, HTML structures
- Writes summary to `.planning/sketches/WRAP-UP-SUMMARY.md`
- Adds auto-load routing line to project CLAUDE.md

Usage: `/gsd:sketch --wrap-up`

### Capturing Ideas, Notes, and Todos

**`/gsd:capture [description]`**
Capture an idea or task as a structured todo from current conversation.

- Extracts context from conversation (or uses provided description)
- Creates structured todo file in `.planning/todos/pending/`
- Infers area from file paths for grouping
- Checks for duplicates before creating
- Updates STATE.md todo count

Usage: `/gsd:capture` (infers from conversation)
Usage: `/gsd:capture Add auth token refresh`

**`/gsd:capture --note <text>`**
Zero-friction note capture — one command, instant save, no questions.

- Saves timestamped note to `.planning/notes/` (or `~/.claude/notes/` globally)
- Three subcommands: append (default), list, promote
- Promote converts a note into a structured todo
- Works without a project (falls back to global scope)

Usage: `/gsd:capture --note refactor the hook system`
Usage: `/gsd:capture --note list`
Usage: `/gsd:capture --note promote 3`
Usage: `/gsd:capture --note --global cross-project idea`

**`/gsd:capture --list [area]`**
List pending todos and select one to work on.

- Lists all pending todos with title, area, age
- Optional area filter (e.g., `/gsd:capture --list api`)
- Loads full context for selected todo
- Routes to appropriate action (work now, add to phase, brainstorm)
- Moves todo to done/ when work begins

Usage: `/gsd:capture --list`
Usage: `/gsd:capture --list api`

**`/gsd:capture --list-seeds [status]`**
List and audit captured seeds (read-only).

- Lists all seeds with ID, status, scope, trigger, and title
- Optional status filter (e.g., `/gsd:capture --list-seeds dormant`)
- Does not modify any seed — enrich with `/gsd:capture --seed --enrich SEED-NNN`

Usage: `/gsd:capture --list-seeds`
Usage: `/gsd:capture --list-seeds dormant`

### User Acceptance Testing

**`/gsd:verify-work [phase]`**
Validate built features through conversational UAT.

- Extracts testable deliverables from SUMMARY.md files
- Presents tests one at a time (yes/no responses)
- Automatically diagnoses failures and creates fix plans
- Ready for re-execution if issues found

Usage: `/gsd:verify-work 3`

### Ship Work

**`/gsd:ship [phase]`**
Create a PR from completed phase work with an auto-generated body.

- Pushes branch to remote
- Creates PR with summary from SUMMARY.md, VERIFICATION.md, REQUIREMENTS.md
- Optionally requests code review
- Updates STATE.md with shipping status

Prerequisites: Phase verified, `gh` CLI installed and authenticated.

Usage: `/gsd:ship 4` or `/gsd:ship 4 --draft`

---

**`/gsd:review --phase N [--gemini] [--claude] [--codex] [--coderabbit] [--opencode] [--qwen] [--cursor] [--agy] [--all]`**
Cross-AI peer review — invoke external AI CLIs to independently review phase plans.

- Detects available CLIs (gemini, claude, codex, coderabbit, agy)
- Each CLI reviews plans independently with the same structured prompt
- CodeRabbit reviews the current git diff (not a prompt) — may take up to 5 minutes
- Produces REVIEWS.md with per-reviewer feedback and consensus summary
- Feed reviews back into planning: `/gsd:plan-phase N --reviews`

Usage: `/gsd:review --phase 3 --all`

---

**`/gsd:pr-branch [target]`**
Create a clean branch for pull requests by filtering out .planning/ commits.

- Classifies commits: code-only (include), planning-only (exclude), mixed (include sans .planning/)
- Cherry-picks code commits onto a clean branch
- Reviewers see only code changes, no GSD artifacts

Usage: `/gsd:pr-branch` or `/gsd:pr-branch main`

---

**`/gsd:capture --seed [idea]`**
Capture a forward-looking idea with trigger conditions for automatic surfacing.

- Seeds preserve WHY, WHEN to surface, and breadcrumbs to related code
- Auto-surfaces during `/gsd:new-milestone` when trigger conditions match
- Better than deferred items — triggers are checked, not forgotten

Usage: `/gsd:capture --seed "add real-time notifications when we build the events system"`

**`/gsd:capture --backlog [description]`**
Add an idea to the backlog parking lot for future milestones.

- Creates a backlog item under 999.x numbering in ROADMAP.md
- Reserves ideas without committing to the current milestone
- Surface and promote later via `/gsd:review-backlog`

Usage: `/gsd:capture --backlog "real-time notifications when events ship"`

---

**`/gsd:audit-uat`**
Cross-phase audit of all outstanding UAT and verification items.
- Scans every phase for pending, skipped, blocked, and human_needed items
- Cross-references against codebase to detect stale documentation
- Produces prioritized human test plan grouped by testability
- Use before starting a new milestone to clear verification debt

Usage: `/gsd:audit-uat`

### Milestone Auditing

**`/gsd:audit-milestone [version]`**
Audit milestone completion against original intent.

- Reads all phase VERIFICATION.md files
- Checks requirements coverage
- Spawns integration checker for cross-phase wiring
- Creates MILESTONE-AUDIT.md with gaps and tech debt

Usage: `/gsd:audit-milestone`

### Configuration

**`/gsd:settings`**
Configure workflow toggles and model profile interactively.

- Toggle researcher, plan checker, verifier agents
- Select model profile (quality/balanced/budget/inherit)
- Updates `.planning/config.json`

Usage: `/gsd:settings`

**`/gsd:config [--profile <profile> | --advanced | --integrations]`**
Configure GSD beyond the basic settings: model profile, advanced tuning, and third-party integrations.

- `--profile <profile>` — quick switch model profile (`quality | balanced | budget | inherit`)
- `--advanced` — power-user tuning: plan bounce, timeouts, branch templates, cross-AI execution (replaces the former `gsd-settings-advanced`)
- `--integrations` — third-party API keys, code-review CLI routing, agent-skill injection (replaces the former `gsd-settings-integrations`)

- `quality` — Opus everywhere except verification
- `balanced` — Opus for planning, Sonnet for execution (default)
- `budget` — Sonnet for writing, Haiku for research/verification
- `inherit` — Use current session model for all agents (OpenCode `/model`)

Usage: `/gsd:config --profile budget`

**`/gsd:surface [list|status|profile <name>|disable <cluster>|enable <cluster>|reset]`**
Toggle which skills are surfaced — apply a profile, list, or disable a cluster without reinstall.

- `list` / `status` — Show enabled and disabled clusters and skills with token cost
- `profile <name>` — Switch to a named base profile (`core`, `standard`, `full`)
- `disable <cluster>` — Remove a cluster from the active surface
- `enable <cluster>` — Add a cluster back to the active surface
- `reset` — Delete the surface delta and return to the install-time profile

Usage: `/gsd:surface list`
Usage: `/gsd:surface profile standard`
Usage: `/gsd:surface disable utility`

### Utility Commands

**`/gsd:cleanup`**
Archive accumulated phase directories from completed milestones.

- Identifies phases from completed milestones still in `.planning/phases/`
- Shows dry-run summary before moving anything
- Moves phase dirs to `.planning/milestones/v{X.Y}-phases/`
- Use after multiple milestones to reduce `.planning/phases/` clutter

Usage: `/gsd:cleanup`

**`/gsd:help [--brief | --full | <topic> | --brief <topic>]`**
Show GSD command help at the tier you ask for.

- `--brief` — one-liner refresher of the top commands (~10 lines)
- *(no flag)* — one-page newcomer tour (default)
- `--full` — the complete reference you are reading now
- `<topic>` — emit only the matching section (e.g. `/gsd:help debug`, `/gsd:help workflow`)
- `--brief <topic>` — compact scoped lookup: signature + one-line summary of the matched section

Every topic output starts with a `**Topic:** \`<alias>\` → \`<heading>\` *(scope: full | compact)*` preamble so resolved routing is visible. See `gsd-core/workflows/help/modes/topic.md` for the full alias table. Unknown topics print the recognized list.

Usage: `/gsd:help`
Usage: `/gsd:help --brief`
Usage: `/gsd:help --full`
Usage: `/gsd:help debug`
Usage: `/gsd:help --brief debug`

**`/gsd:update [--sync] [--reapply] [--next | --rc]`**
Update GSD to latest version with changelog preview.

- `--sync` — sync managed GSD skills across runtime roots (replaces the former `gsd-sync-skills`)
- `--reapply` — reapply local modifications after an update (replaces the former `gsd-reapply-patches`)
- `--next` (alias `--rc`) — install/refresh from the `@next` RC dist-tag instead of `@latest` (ADR #660); omit for the stable channel

- Shows installed vs latest version comparison
- Displays changelog entries for versions you've missed
- Highlights breaking changes
- Confirms before running install
- Better than raw `npx @opengsd/gsd-core`

Usage: `/gsd:update`

## Additional Commands

The commands above cover the most common day-to-day flows. Every command listed here is also a live `/gsd-*` slash command and is grouped by purpose.

### Discovery & Specification

- **`/gsd:explore`** — Socratic ideation and idea routing. Think through ideas before committing to plans.
- **`/gsd:spec-phase <phase> [--auto] [--text]`** — Clarify WHAT a phase delivers with ambiguity scoring; produces a SPEC.md before discuss-phase.
- **`/gsd:ai-integration-phase [phase]`** — Generate an AI-SPEC.md design contract for phases that involve building AI systems.
- **`/gsd:ui-phase [phase]`** — Generate UI design contract (UI-SPEC.md) for frontend phases.
- **`/gsd:import --from <filepath> | --from-gsd2`** — Ingest external plans with conflict detection, or reverse-migrate a GSD-2 (`.gsd/`) project back to GSD v1 (`.planning/`) format.
- **`/gsd:ingest-docs [path] [--mode new|merge] [--manifest <file>] [--resolve auto|interactive]`** — Bootstrap or merge a `.planning/` setup from existing ADRs, PRDs, SPECs, and docs in a repo.

### Planning & Execution

- **`/gsd:mvp-phase <phase-number>`** — Plan a phase as a vertical MVP slice (user story + SPIDR splitting) before handing off to plan-phase. Same end-state as `/gsd:plan-phase --mvp`, with a guided MVP-shaping intro.
- **`/gsd:ultraplan-phase [phase]`** — [BETA] Offload plan phase to Claude Code's ultraplan cloud; review in browser and import back.
- **`/gsd:plan-review-convergence <phase> [--codex] [--gemini] [--claude] [--opencode] [--ollama] [--lm-studio] [--llama-cpp] [--all] [--text] [--ws <name>] [--max-cycles N]`** — Cross-AI plan convergence loop — replan with review feedback until no HIGH concerns remain. Supports both cloud reviewers (Codex/Gemini/Claude/OpenCode) and local model runtimes (Ollama, LM Studio, llama.cpp).
- **`/gsd:autonomous [--from N] [--to N] [--only N] [--interactive] [--converge]`** — Run all remaining phases autonomously: discuss → plan → execute per phase. `--converge` routes planning through plan-review convergence; `--cross-ai` is an alias.

### Quality, Review & Verification

- **`/gsd:code-review <phase> [--depth=quick|standard|deep] [--files file1,file2,...] [--fix [--all] [--auto]]`** — Review source files changed during a phase for bugs, security issues, and code quality problems.
- **`/gsd:secure-phase [phase]`** — Retroactively verify threat mitigations for a completed phase.
- **`/gsd:validate-phase [phase]`** — Retroactively audit and fill Nyquist validation gaps for a completed phase.
- **`/gsd:ui-review [phase]`** — Retroactive 6-pillar visual audit of implemented frontend code.
- **`/gsd:eval-review [phase]`** — Audit an executed AI phase's evaluation coverage and produce an EVAL-REVIEW.md remediation plan.
- **`/gsd:audit-fix --source <audit-uat> [--severity medium|high|all] [--max N] [--dry-run]`** — Autonomous audit-to-fix pipeline: find issues, classify, fix, test, commit.
- **`/gsd:add-tests <phase> [additional instructions]`** — Generate tests for a completed phase based on UAT criteria and implementation.

### Diagnostics & Maintenance

- **`/gsd:health [--repair] [--context]`** — Diagnose planning directory health and optionally repair issues.
- **`/gsd:forensics [problem description]`** — Post-mortem investigation for failed GSD workflows; diagnoses what went wrong.
- **`/gsd:undo --last N | --phase NN | --plan NN-MM`** — Safe git revert. Roll back phase or plan commits using the phase manifest with dependency checks.
- **`/gsd:docs-update [--force] [--verify-only]`** — Generate or update project documentation verified against the codebase.
- **`/gsd:extract-learnings <phase>`** — Extract decisions, lessons, patterns, and surprises from completed phase artifacts.

### Knowledge & Context

- **`/gsd:graphify [build|query <term>|status|diff]`** — Build, query, and inspect the project knowledge graph in `.planning/graphs/`.
- **`/gsd:mempalace-recall`** — Recall prior decisions, patterns, and surprises from MemPalace before planning.
- **`/gsd:mempalace-capture [artifact-type]`** — File a phase artifact into MemPalace and mirror decision facts into its temporal KG.
- **`/gsd:thread [list [--open|--resolved] | close <slug> | status <slug> | name | description]`** — Manage persistent context threads for cross-session work.
- **`/gsd:profile-user [--questionnaire] [--refresh]`** — Generate developer behavioral profile and create Claude-discoverable artifacts.
- **`/gsd:stats`** — Display project statistics: phases, plans, requirements, git metrics, and timeline.

### Workflow & Orchestration

- **`/gsd:manager [--analyze-deps]`** — Interactive command center for managing multiple phases from one terminal. `--analyze-deps` scans ROADMAP phases for dependency relationships before parallel execution.
- **`/gsd:workspace [--new | --list | --remove] [name]`** — Manage GSD workspaces: create, list, or remove isolated workspace environments.
- **`/gsd:workstreams`** — Manage parallel workstreams: list, create, switch, status, progress, complete, and resume.
- **`/gsd:review-backlog`** — Review and promote backlog items to active milestone.
- **`/gsd:milestone-summary [version]`** — Generate a comprehensive project summary from milestone artifacts for team onboarding and review.

### Repository Integration

- **`/gsd:inbox [--issues] [--prs] [--label] [--close-incomplete] [--repo owner/repo]`** — Triage and review open GitHub issues and PRs against project templates and contribution guidelines.

### Namespace Routers (model-facing meta-skills)

These six skills exist primarily for the model to perform two-stage hierarchical routing across 60+ skills. You can invoke them directly when you want to browse a category interactively.

- **`/gsd-context`** — Codebase intelligence routing (map, graphify, docs, learnings, mempalace).
- **`/gsd-ideate`** — Exploration / capture routing (explore, sketch, spike, spec, capture).
- **`/gsd-manage`** — Configuration and workspace routing (workstreams, thread, update, ship, inbox).
- **`/gsd-project`** — Project-lifecycle routing (milestones, audits, summary).
- **`/gsd-quality`** — Quality-gate routing (code review, debug, audit, security, eval, ui).
- **`/gsd-workflow`** — Phase-pipeline routing (discuss, plan, execute, verify, phase, progress).

## Files & Structure

```text
.planning/
├── PROJECT.md            # Project vision
├── ROADMAP.md            # Current phase breakdown
├── STATE.md              # Project memory & context
├── RETROSPECTIVE.md      # Living retrospective (updated per milestone)
├── config.json           # Workflow mode & gates
├── todos/                # Captured ideas and tasks
│   ├── pending/          # Todos waiting to be worked on
│   └── done/             # Completed todos
├── spikes/               # Spike experiments (/gsd:spike)
│   ├── MANIFEST.md       # Spike inventory and verdicts
│   └── NNN-name/         # Individual spike directories
├── sketches/             # Design sketches (/gsd:sketch)
│   ├── MANIFEST.md       # Sketch inventory and winners
│   ├── themes/           # Shared CSS theme files
│   └── NNN-name/         # Individual sketch directories (HTML + README)
├── debug/                # Active debug sessions
│   └── resolved/         # Archived resolved issues
├── milestones/
│   ├── v1.0-ROADMAP.md       # Archived roadmap snapshot
│   ├── v1.0-REQUIREMENTS.md  # Archived requirements
│   └── v1.0-phases/          # Archived phase dirs (via /gsd:cleanup or milestone complete, which archives by default)
│       ├── 01-foundation/
│       └── 02-core-features/
├── codebase/             # Codebase map (brownfield projects)
│   ├── STACK.md          # Languages, frameworks, dependencies
│   ├── ARCHITECTURE.md   # Patterns, layers, data flow
│   ├── STRUCTURE.md      # Directory layout, key files
│   ├── CONVENTIONS.md    # Coding standards, naming
│   ├── TESTING.md        # Test setup, patterns
│   ├── INTEGRATIONS.md   # External services, APIs
│   └── CONCERNS.md       # Tech debt, known issues
└── phases/
    ├── 01-foundation/
    │   ├── 01-01-PLAN.md
    │   └── 01-01-SUMMARY.md
    └── 02-core-features/
        ├── 02-01-PLAN.md
        └── 02-01-SUMMARY.md
```

## Workflow Modes

Set during `/gsd:new-project`:

**Interactive Mode**

- Confirms each major decision
- Pauses at checkpoints for approval
- More guidance throughout

**YOLO Mode**

- Auto-approves most decisions
- Executes plans without confirmation
- Only stops for critical checkpoints

Change anytime by editing `.planning/config.json`

## Planning Configuration

Configure how planning artifacts are managed in `.planning/config.json`:

**`planning.commit_docs`** (default: `true`)
- `true`: Planning artifacts committed to git (standard workflow)
- `false`: Planning artifacts kept local-only, not committed

When `commit_docs: false`:
- Add `.planning/` to your `.gitignore`
- Useful for OSS contributions, client projects, or keeping planning private
- All planning files still work normally, just not tracked in git

**`planning.search_gitignored`** (default: `false`)
- `true`: Add `--no-ignore` to broad ripgrep searches
- Only needed when `.planning/` is gitignored and you want project-wide searches to include it

Example config:
```json
{
  "planning": {
    "commit_docs": false,
    "search_gitignored": true
  }
}
```

## Common Workflows

**Starting a new project:**

```text
/gsd:new-project        # Unified flow: questioning → research → requirements → roadmap
/clear
/gsd:plan-phase 1       # Create plans for first phase
/clear
/gsd:execute-phase 1    # Execute all plans in phase
```

**Resuming work after a break:**

```text
/gsd:progress  # See where you left off and continue
```

**Adding urgent mid-milestone work:**

```text
/gsd:phase --insert 5 "Critical security fix"
/gsd:plan-phase 5.1
/gsd:execute-phase 5.1
```

**Completing a milestone:**

```text
/gsd:complete-milestone 1.0.0
/clear
/gsd:new-milestone  # Start next milestone (questioning → research → requirements → roadmap)
```

**Capturing ideas during work:**

```text
/gsd:capture                                  # Capture from conversation context
/gsd:capture Fix modal z-index                # Capture with explicit description
/gsd:capture --note refactor auth system      # Quick friction-free note
/gsd:capture --seed "real-time notifications" # Forward-looking idea with triggers
/gsd:capture --list                           # Review and work on todos
/gsd:capture --list api                       # Filter by area
```

**Debugging an issue:**

```text
/gsd:debug "form submission fails silently"  # Start debug session
# ... investigation happens, context fills up ...
/clear
/gsd:debug                                    # Resume from where you left off
```

## Getting Help

- Read `.planning/PROJECT.md` for project vision
- Read `.planning/STATE.md` for current context
- Check `.planning/ROADMAP.md` for phase status
- Run `/gsd:progress` to check where you're up to
</reference>
