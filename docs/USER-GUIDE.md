# GSD User Guide

A narrative companion guide to GSD Core — orient yourself here, then follow the links into the dedicated docs.

> **GSD Core's documentation is organised by [Diataxis](https://diataxis.fr).**
> Browse by goal: [Tutorials](README.md#tutorials) · [How-to guides](README.md#how-to-guides) · [Reference](README.md#reference) · [Explanation](README.md#explanation) · [Docs index](README.md)

---

## Table of Contents

- [Slash-command forms](#slash-command-form)
- [Namespace routing primer](#namespace-routing-primer-gsd-ns--v140)
- [Reading GSD's output](#reading-gsds-output)
- [Project lifecycle overview](#project-lifecycle-overview)
- [Workflow Diagrams](#workflow-diagrams)
- [UI Design Contract](#ui-design-contract)
- [Spiking & Sketching](#spiking--sketching)
- [Backlog & Threads](#backlog--threads)
- [Workstreams & Workspaces](#workstreams--workspaces)
- [Security](#security)
- [Usage Examples](#usage-examples)
- [Troubleshooting](#troubleshooting)
- [Recovery Quick Reference](#recovery-quick-reference)
- [Related](#related)

For driving GSD directly from a GitHub / Linear / Jira issue, see the
[How to drive GSD Core from a tracker issue](how-to/drive-gsd-from-a-tracker-issue.md)
guide; [Issue-driven orchestration explained](issue-driven-orchestration.md)
maps tracker issues onto the workspace → discuss → plan → execute → verify →
review → ship loop and says why it is safe.

---

## Slash-command form

GSD ships **the same set of skills** to every supported runtime, using the hyphen slash-form spelling:

- **Hyphen form** — `/gsd-command-name` — used by Claude Code, Copilot, OpenCode, Kilo, Cursor, Windsurf, Augment, Antigravity, and Trae.

The installer writes this form into the command directory of each runtime you target.

## Namespace routing primer (`gsd-ns-*`, v1.40+)

### Architecture

GSD ships six **namespace router bundles** (`gsd-ns-workflow`, `gsd-ns-project`, `gsd-ns-review`, `gsd-ns-context`, `gsd-ns-ideate`, `gsd-ns-manage`). On runtimes with non-recursive skill loaders, the installer emits these 6 routers as the **only top-level skill entries**; the ~61 concrete skills are nested under each router at `<router>/skills/<name>/SKILL.md`. This reduces the eager skill-listing overhead to ≈6 entries instead of ≈67.

Each router's body contains a routing table. When the model receives a request, it reads the router, identifies the relevant sub-skill by name, then opens `skills/<name>/SKILL.md` via a file-path `Read`. The concrete skill is fully available — it is not invocable by bare name through the Skill tool's top-level listing, but is reachable through the router.

The nested layout applies only to runtimes with confirmed non-recursive skill loaders: **Cline, Qwen, Hermes, Augment, Trae**. Claude's loader is also non-recursive, but #924 reverted it flat because the Skill tool hard-errors on unknown names rather than re-routing via the router. Antigravity's loader is also non-recursive, but #1614 moved it flat because `agy` scans only `skills/<name>/SKILL.md` — nested sub-skills were unreachable. Other recursive or unconfirmed loaders (Cursor, Codex, Copilot, Windsurf, CodeBuddy, OpenCode, Kilo) retain the flat layout unchanged.

| Namespace | Router bundle | Routes to |
|-----------|--------------|-----------|
| Phase pipeline | `gsd-ns-workflow` | discuss / plan / execute / verify / phase / progress |
| Project lifecycle | `gsd-ns-project` | milestones, audits, summary |
| Quality gates | `gsd-ns-review` | code review, debug, audit, security, eval, ui |
| Codebase intelligence | `gsd-ns-context` | map, graphify, docs, learnings |
| Exploration & capture | `gsd-ns-ideate` | explore, sketch, spike, spec, capture |
| Management | `gsd-ns-manage` | config, workspace, workstreams, thread, update, ship, inbox |

### Slash commands are unaffected

On runtimes that install a commands surface (`commands/gsd`), slash commands such as `/gsd-plan-phase` continue to work directly — the nesting applies only to the Skill tool's top-level listing, not to the commands directory.

### Migration note (breaking change on nesting runtimes)

On the seven nesting runtimes listed above, upgrading to v1.40 changes skill invocation behaviour:

- **Before:** each of the ~67 concrete `gsd-<name>` skills appeared at the top level and was invocable by bare name through the Skill tool.
- **After:** only the 6 `gsd-ns-*` router bundles appear at the top level. Concrete skills are reachable via the router's routing table and a `Read skills/<name>/SKILL.md` call. Direct bare-name invocation of concrete skills through the Skill tool's listing no longer works.
- **Slash commands unchanged:** `/gsd-plan-phase`, `/gsd-discuss-phase`, etc. still work directly where a commands surface is installed.
- **Upgrade prune:** the installer's existing prune step removes the legacy top-level `gsd-<concrete>/` skill directories on upgrade — no manual cleanup is needed.

---

## Reading GSD's output

GSD marks its sections with Markdown, not with drawn borders. There are exactly
three forms, and every workflow, checkpoint and report uses them:

| You see | It means |
|---|---|
| `### GSD ► {STAGE NAME}` | A major workflow transition — planning, executing a wave, verifying, completing |
| `### CHECKPOINT: {Type}` | GSD is waiting on you. The bolded `**→ …**` line at the bottom tells you what to type |
| `---` | A break between two sections — most often before the **▶ Next Up** block at the end of a completion |

Panels that used to be drawn with box characters are now a heading followed by
their rows as ordinary lines. A checkpoint reads:

```
### CHECKPOINT: Verification Required

Progress: 5/8 tasks complete
Task: Responsive dashboard layout

How to verify:
  1. Visit: http://localhost:3000/dashboard

---

**→ YOUR ACTION: Type "approved" or describe issues**
```

### Why there are no drawn borders

Earlier releases framed banners and checkpoints with fixed-width runs of box-drawing characters. In a pane narrower than the run the rule wraps and the frame comes apart from its heading, so the output looked broken ([#3028](https://github.com/open-gsd/gsd-core/issues/3028), against the Codex desktop interface). A Markdown heading and a thematic break carry the same structure at any width. Every runtime gets the same output; if a host reads worse with headings than it did with boxes, report it. Single-cell tokens (`✓ ✗ ◆ ○ ⚠`, the `GSD ►` prefix and the ten-cell progress gauge) do not wrap and are unchanged.

The convention and the reasoning for making it unconditional are in [`ui-brand.md`](../gsd-core/references/ui-brand.md), and `tests/responsive-separators.test.cjs` enforces it against all shipped content.

---

## Project lifecycle overview

The core GSD loop is: **discuss → plan → execute → verify → ship**, repeated per phase. The full step-by-step walkthrough — including example outputs, what files get created, and all the flags in play — is in the dedicated tutorial.

See [Your first project](tutorials/your-first-project.md).

For onboarding an existing codebase before starting a new milestone, run `/gsd-onboard` or see [Onboarding an existing codebase](tutorials/onboarding-an-existing-codebase.md).

**Relevant flags at a glance:**

| Flag | Command | When to use |
| ---- | ------- | ----------- |
| `--auto` | `/gsd-new-project` | Skip interactive questions, ingest from a PRD file |
| `--research` | `/gsd-quick` | Add a research agent to an ad-hoc task |
| `--validate` | `/gsd-quick` | Add plan-checking and post-execution verification |
| `--chain` | `/gsd-discuss-phase` | Auto-chain discuss → plan → execute without stopping |
| `--skip-research` | `/gsd-plan-phase` | Skip research agents when the domain is already familiar |
| `--draft` | `/gsd-ship` | Create a draft PR instead of a ready-for-review one |

For the full command reference with all flags, see [`docs/COMMANDS.md`](COMMANDS.md). For configuration options (model profiles, workflow agents, git branching), see [`docs/CONFIGURATION.md`](CONFIGURATION.md).

### The implicit first milestone

`/gsd-new-project` does not register a milestone. On a fresh project there is no `MILESTONES.md`, no `milestone:` value in `STATE.md`, and no version token in `ROADMAP.md` — by design ([ADR-3180](adr/3180-planning-semantic-model-single-owner.md) §7.2 rule 5): a ROADMAP with no version token has no milestone identity, and the runtime must not invent one.

The first milestone is therefore **implicit**: it is "everything between `/gsd-new-project` and the first `/gsd-complete-milestone <version>`". Its identity is recorded only at close time — the version from the command argument, the name from the separate `--name` value the close workflow passes alongside it (defaulting to the version when no name is given). There is no start-registration step to look for, and none is needed; `/gsd-new-milestone` (the cycle opener) is intended for the second milestone onward, where it reads the previous version from `MILESTONES.md` and records the new identity at cycle start.

Until the first close, while `ROADMAP.md` carries no version token, the milestone-aware commands report no current milestone: `gsd_run query init.manager` emits `milestone_version: null` and `milestone_name: null`, and `gsd_run query init.new-milestone` emits `current_milestone: null` — the documented state, not data loss.

---

## Workflow Diagrams

### Full Project Lifecycle

```text
  ┌──────────────────────────────────────────────────┐
  │                   NEW PROJECT                    │
  │  /gsd-new-project                                │
  │  Questions -> Research -> Requirements -> Roadmap│
  └─────────────────────────┬────────────────────────┘
                            │
             ┌──────────────▼─────────────┐
             │      FOR EACH PHASE:       │
             │                            │
             │  ┌────────────────────┐    │
             │  │ /gsd-discuss-phase │    │  <- Lock in preferences
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-ui-phase      │    │  <- Design contract (frontend)
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-plan-phase    │    │  <- Research + Plan + Verify
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-execute-phase │    │  <- Parallel execution
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-verify-work   │    │  <- Manual UAT
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-ship          │    │  <- Create PR (optional)
             │  └──────────┬─────────┘    │
             │             │              │
             │     Next Phase?────────────┘
             │             │ No
             └─────────────┼──────────────┘
                            │
            ┌───────────────▼──────────────┐
            │  /gsd-audit-milestone        │
            │  /gsd-complete-milestone     │
            └───────────────┬──────────────┘
                            │
                   Another milestone?
                       │          │
                      Yes         No -> Done!
                       │
               ┌───────▼──────────────┐
               │  /gsd-new-milestone  │
               └──────────────────────┘
```

### Planning Agent Coordination

```text
  /gsd-plan-phase N
         │
         ├── Phase Researcher (x4 parallel)
         │     ├── Stack researcher
         │     ├── Features researcher
         │     ├── Architecture researcher
         │     └── Pitfalls researcher
         │           │
         │     ┌──────▼──────┐
         │     │ RESEARCH.md │
         │     └──────┬──────┘
         │            │
         │     ┌──────▼──────┐
         │     │   Planner   │  <- Reads PROJECT.md, REQUIREMENTS.md,
         │     │             │     CONTEXT.md, RESEARCH.md
         │     └──────┬──────┘
         │            │
         │     ┌──────▼───────────┐     ┌────────┐
         │     │   Plan Checker   │────>│ PASS?  │
         │     └──────────────────┘     └───┬────┘
         │                                  │
         │                             Yes  │  No
         │                              │   │   │
         │                              │   └───┘  (loop, up to 3x)
         │                              │
         │                        ┌─────▼──────┐
         │                        │ PLAN files │
         │                        └────────────┘
         └── Done
```

### Validation Architecture (Nyquist Layer)

During plan-phase research, GSD maps automated test coverage to each phase requirement before any code is written, and the plan-checker refuses plans whose tasks lack an automated verify command. The result is `{phase}-VALIDATION.md`. Set `workflow.nyquist_validation: false` in `/gsd-settings` for rapid prototyping phases. How the layer works: [Nyquist validation explained](explanation/nyquist-validation.md).

### Retroactive Validation (`/gsd-validate-phase`)

For phases executed before the Nyquist layer existed, or codebases with only traditional test suites, `/gsd-validate-phase N` audits coverage and generates the missing tests without touching implementation code. The flow and its COMPLIANT and PARTIAL outcomes are in [Nyquist validation explained](explanation/nyquist-validation.md#retroactive-validation-with-gsd-validate-phase).

### Assumptions Discussion Mode

By default `/gsd-discuss-phase` asks open-ended questions about your implementation preferences. Assumptions mode inverts this: GSD reads your codebase first, surfaces structured assumptions about how it would build the phase, and asks only for corrections. Turn it on with `workflow.discuss_mode: 'assumptions'` via `/gsd-settings`. The steps are in [How to discuss a phase](how-to/discuss-a-phase.md), and the full reference is [workflow-discuss-mode.md](workflow-discuss-mode.md).

### Decision Coverage Gates

Decisions captured in CONTEXT.md as numbered bullets (`- **D-01:** …`) are checked twice: a blocking gate after planning refuses to mark the phase planned until every trackable decision appears in a plan, and a non-blocking gate during verification logs misses to VERIFICATION.md. What the gates scan, how to write decisions they accept, and how to opt a decision out are in [Decision coverage gates explained](explanation/decision-coverage-gates.md). To turn both gates off, set `workflow.context_coverage_gate: false` (the key must sit under `workflow`); see [`workflow.context_coverage_gate`](CONFIGURATION.md#decision-coverage-gates-workflowcontext_coverage_gate).

### Execution Wave Coordination

```text
  /gsd-execute-phase N
         │
         ├── Analyze plan dependencies
         │
         ├── Wave 1 (independent plans):
         │     ├── Executor A (fresh 200K context) -> commit
         │     └── Executor B (fresh 200K context) -> commit
         │
         ├── Wave 2 (depends on Wave 1):
         │     └── Executor C (fresh 200K context) -> commit
         │
         └── Verifier
               ├── Check codebase against phase goals
               ├── Test quality audit (disabled tests, circular patterns, assertion strength)
               │
               ├── PASS -> VERIFICATION.md (success)
               └── FAIL -> Issues logged for /gsd-verify-work
```

### Isolated-run Recovery (fail-safe)

When a worktree-isolated run is rejected — the user declines to merge it, or the run over-reached the requested scope, or the orchestrator surfaces recovery guidance for a blocked plan — GSD halts safely and offers two options: (a) re-attempt in a fresh, narrowly-scoped worktree, or (b) inspect or discard the rejected worktree without merging. GSD never defaults recovery to editing the primary checkout (`main`). Any path that edits the primary checkout requires explicit, clearly-labeled confirmation from the user first. This behavior is unconditional and applies to both `/gsd-execute-phase` (worktree executor waves) and `/gsd-quick` (quick-mode isolated runs).

---

## UI Design Contract

AI-generated frontends are visually inconsistent not because Claude Code is bad at UI but because no design contract existed before execution. `/gsd-ui-phase` locks the design contract before planning; `/gsd-ui-review` audits the result after execution.

For the full workflow, configuration, shadcn initialisation, and the registry safety gate, see [Design a UI phase](how-to/design-a-ui-phase.md).

**Quick reference:**

| Command              | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `/gsd-ui-phase [N]`  | Generate UI-SPEC.md design contract for a frontend phase |
| `/gsd-ui-review [N]` | Retroactive 6-pillar visual audit of implemented UI      |

| Setting                   | Default | Description                                                 |
| ------------------------- | ------- | ----------------------------------------------------------- |
| `workflow.ui_phase`       | `true`  | Generate UI design contracts for frontend phases            |
| `workflow.ui_safety_gate` | `true`  | plan-phase prompts to run /gsd-ui-phase for frontend phases |

---

## Spiking & Sketching

Use `/gsd-spike` to validate technical feasibility before planning, and `/gsd-sketch` to explore visual direction before designing. Both store artifacts in `.planning/` and integrate with the project-skills system via their wrap-up companions.

For the full workflow and flow diagram, see [Spike and sketch](how-to/spike-and-sketch.md).

**Typical flow:**

```bash
/gsd-spike "SSE vs WebSocket"     # Validate the approach
/gsd-spike --wrap-up              # Package learnings

/gsd-sketch "real-time feed UI"   # Explore the design
/gsd-sketch --wrap-up             # Package decisions

/gsd-discuss-phase N              # Lock in preferences (now informed by spike + sketch)
/gsd-plan-phase N                 # Plan with confidence
```

---

## Backlog & Threads

Three tools keep an idea out of the way until it is ready, and each answers a different question:

- **Backlog** (`/gsd-capture --backlog`): work you might plan someday. It gets a full `999.x` phase directory outside the active sequence, and `/gsd-review-backlog` lets you promote, keep or remove it.
- **Seeds** (`/gsd-capture --seed`): ideas with a trigger condition. They surface by themselves when `/gsd-new-milestone` runs, and you close them once they have been acted on.
- **Threads** (`/gsd-thread`): work that spans several sessions but fits no phase.

The steps for each are in [How to park an idea for later](how-to/park-an-idea-for-later.md); the flags are in [`/gsd-capture`](COMMANDS.md#gsd-capture).

---

## Workstreams & Workspaces

Workstreams and workspaces both provide isolation, but at different levels.

**Workstreams** share the same codebase and git history but isolate planning artifacts — lighter weight, good for working on multiple milestone areas concurrently. See [Work in parallel with workstreams](how-to/work-in-parallel-with-workstreams.md).

**Workspaces** create separate repo worktrees with their own `.planning/` — heavier, for feature-branch or multi-repo isolation. See [Isolate work with workspaces](how-to/isolate-work-with-workspaces.md).

| Command                            | Purpose                                              |
| ---------------------------------- | ---------------------------------------------------- |
| `/gsd-workstreams create <name>`   | Create a new workstream with isolated planning state |
| `/gsd-workstreams switch <name>`   | Switch active context to a different workstream      |
| `/gsd-workstreams list`            | Show all workstreams and which is active             |
| `/gsd-workstreams complete <name>` | Mark a workstream as done and archive its state      |

```bash
# Workspace example — feature branch isolation
/gsd-workspace --new --name feature-b --repos .
cd ~/gsd-workspaces/feature-b
/gsd-new-project

/gsd-workspace --list
/gsd-workspace --remove feature-b
```

---

## Security

### Defense-in-Depth (v1.27)

GSD generates markdown files that become LLM system prompts. This means any user-controlled text flowing into planning artifacts is a potential indirect prompt injection vector. v1.27 introduced centralised security hardening:

**Path Traversal Prevention:** User-supplied file paths that GSD writes to or resolves into the project (e.g. `--prd`) are validated to resolve within the project directory. macOS `/var` → `/private/var` symlink resolution is handled. Read-once text inputs whose contents are copied into STATE.md (`--summary-file`, `--rationale-file`, `--text-file`, `--note-file`) are not confined and accept any readable file (#4926).

**Prompt Injection Detection:** The `security.cjs` module scans for known injection patterns in user-supplied text before it enters planning artifacts.

**Runtime hooks:** `gsd-prompt-guard.js` scans writes to `.planning/` for injection patterns (always on, advisory); `gsd-workflow-guard.js` warns on edits outside a GSD workflow (opt-in via `hooks.workflow_guard`); `gsd-write-guard.js` blocks a whole-file `Write` that collapses a curated `.planning/` artifact; `gsd-secret-read-guard.js` blocks reads of `.env` and `.secrets` files. The exact rules, limits, bypasses and known gaps of each are in [Security hooks](reference/security-hooks.md).

**CI scanner:** `prompt-injection-scan.security.test.cjs` scans all agent, workflow and command files for embedded injection vectors.

---

### Package Legitimacy Gate (v1.42.1)

Every package a phase recommends is checked against the live npm, PyPI and crates.io registries before it can reach your shell, so a hallucinated name that an attacker has pre-registered (*slopsquatting*) is stopped at research. The threat, the three pipeline stages, the ecosystem coverage and what happens when a registry cannot be reached are in [Layer 1 of the security model](explanation/security-model.md#layer-1--supply-chain-protection-the-package-legitimacy-gate).

**In RESEARCH.md** — every phase that recommends external packages includes a `## Package Legitimacy Audit` table:

```markdown
## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| express | npm | 13 yrs | 100M+/wk | github.com/expressjs/express | [OK] | Approved |
| some-new-util | npm | 3 days | 47 | none | [SLOP] | REMOVED |
| api-bridge | npm | 6 mo | 1.2k/wk | github.com/user/api-bridge | [SUS] | Flagged |
```

A `[SUS]` or `[ASSUMED]` package makes the planner add a `checkpoint:human-verify` task before the install, and a failed install stops the executor at a checkpoint.

**Legitimacy verdicts:**

| Verdict | Meaning | GSD action |
|---------|---------|------------|
| `[OK]` | Passes all legitimacy checks | Proceeds — no checkpoint added |
| `[SUS]` | Suspicious signals | Flagged; planner adds `checkpoint:human-verify` |
| `[SLOP]` | High-confidence hallucination | Removed from RESEARCH.md; never reaches planner |

---

## Code Review Workflow

After executing a phase, run a structured code review before UAT. See [Set up cross-AI review](how-to/set-up-cross-ai-review.md) for the full workflow.

```bash
/gsd-code-review 3               # Review all changed files in phase 3
/gsd-code-review 3 --depth=deep  # Deep cross-file review
/gsd-code-review 3 --fix         # Fix Critical + Warning findings atomically
/gsd-code-review 3 --fix --auto  # Fix and re-review until clean (max 3 iterations)
/gsd-audit-fix                   # Audit + classify + fix (medium+ severity, max 5)
```

The review step slots in after execution and before UAT:

```text
/gsd-execute-phase N  ->  /gsd-code-review N  ->  /gsd-code-review N --fix  ->  /gsd-verify-work N
```

**Optional external source-review lanes (#4209):** `/gsd-code-review` accepts the same reviewer-lane flags as `/gsd-review` (run `gsd_run review-lane flags` to list the flags your installation's roster declares, e.g. `--codex`, `--agy`). Adding one asks that lane to independently review the *same* file scope alongside the internal `gsd-code-reviewer` agent; its findings are unverified corroborating evidence that `gsd-code-reviewer` re-checks against the actual source before writing anything to `REVIEW.md` — there is still exactly one `REVIEW.md`. No reviewer-lane flag is the default and reviews with only the internal agent, unchanged from before #4209. This is separate from `/gsd-review`, which reviews `PLAN.md` files *before* execution, not source code — see [Set up cross-AI review](how-to/set-up-cross-ai-review.md).

```bash
/gsd-code-review 3 --codex       # Corroborate the internal review with the codex reviewer lane
```

---

## Coverage-Aware UAT Routing

Historically, `/gsd-verify-work` turned every `## Accomplishments` bullet in a SUMMARY into a manual checkpoint — even deliverables already covered one-to-one by a passing unit test. With a green test suite you were still asked to re-confirm things the tests had already proven, every phase.

GSD now lets the executor record, at authoring time, *how each deliverable was verified*. When a SUMMARY.md carries a `coverage:` frontmatter block (see [the `coverage:` block reference](COMMANDS.md#summary-coverage-block)), `/gsd-verify-work` routes deterministically:

- **Auto-passed** — a deliverable marked `human_judgment: false` whose `verification` list is non-empty and entirely `pass` is recorded as passed (`source: automated`) and never prompted.
- **Presented** — everything else is shown to you for sign-off: anything flagged `human_judgment: true` (visual adequacy, multi-device behaviour, subjective quality), anything with no verification, anything not fully passing, and any malformed entry.

The asymmetry is deliberate. The worst outcome is auto-passing something broken that UAT existed to catch, so auto-pass is the narrow, fully-proven case and *uncertainty always routes back to you*. Flipping the flag alone cannot skip a prompt — a passing test reference is also required. SUMMARYs without a `coverage:` block behave exactly as before (prose-based checkpoints), so nothing changes for existing or un-migrated phases.

---

## Command And Configuration Reference

- **Command Reference:** see [`docs/COMMANDS.md`](COMMANDS.md) for every stable command's flags, subcommands, and examples.
- **Configuration Reference:** see [`docs/CONFIGURATION.md`](CONFIGURATION.md) for the full `config.json` schema, model-profile table, git branching strategies, and security settings.
- **Discuss Mode:** see [`docs/workflow-discuss-mode.md`](workflow-discuss-mode.md) for interview vs assumptions mode.

### Graphify capability gate (tri-state, v1.43+)

Graphify commands (`graphify status`, `graphify build`, `graphify query`, `graphify diff`) now respect the **full tri-state capability gate**:

1. **Installed** — the `gsd-graphify-*` skills are present in the active install profile.
2. **Surfaced** — those skills appear on the current runtime surface (e.g., in `~/.claude/commands/gsd/`).
3. **Config-enabled** — `graphify.enabled: true` is set in `.planning/config.json`.

All three conditions must be true. Setting `graphify.enabled: true` alone is no longer sufficient if graphify has not been installed and surfaced. If graphify commands return `{ disabled: true }` after upgrading, verify that the install profile includes graphify skills (`gsd-tools capability state`) and re-run the installer to surface them.

### Intel capability gate (tri-state, v1.44+)

Intel commands (`intel status`, `intel query`, `intel diff`, `intel snapshot`, `intel validate`, `intel api-surface`) now respect the **full tri-state capability gate** (same resolver as graphify above):

1. **Installed** — the intel capability is present in the active install profile (intel has no skill files, so this is vacuously true for all profiles).
2. **Surfaced** — the intel capability is on the current runtime surface (vacuously true for all surfaces since intel registers no skill stems).
3. **Config-enabled** — `intel.enabled: true` is set in `.planning/config.json`.

For intel, conditions 1 and 2 are always satisfied (intel has no skill files). The effective gate is `intel.enabled` in config — the same behaviour as before, but now enforced through the shared `isCapabilityActive('intel', cwd)` resolver rather than a direct config read. This means intel honours the full capability-state pipeline, including any future install-profile or surface restrictions. If intel commands return `{ disabled: true }`, ensure `intel.enabled: true` is set in `.planning/config.json` and verify `gsd-tools capability state` shows intel as active.

### Compact content mode (`workflow.compact_content`, v4139+)

GSD's own workflow instructions, planning-artifact templates, and (for non-Claude runtimes)
agent personas are prose — and a large eagerly-loaded instruction body is context the model
spends on GSD's own orchestration rather than on your code. `workflow.compact_content` (default
`false`) opts a project into token-minimized variants of that content wherever one has been
authored, without changing what GSD actually does.

**Why turn it on: finite attention, not price.** The point of this key is not a cheaper
invocation — with prompt caching, the per-request cost of re-sending a large instruction file
is already small. The point is what a large always-loaded instruction body costs in *attention*:
every byte of GSD's own prose sitting in context is a byte not spent reasoning about your
codebase. That cost is paid whether or not the tokens were cheap to transport. Turn it on when
you're running long sessions, working in a large codebase that already competes for context, or
on a runtime with a small context window; leave it off (the default) if you'd rather have every
elaboration and worked example available up front, or you're evaluating GSD for the first time
and want full detail while you learn how it thinks.

**What actually changes.** Nothing is compressed at runtime. Every compact variant is a
hand-authored, reviewed file sitting beside its canonical sibling — the key only chooses which
one GSD reads. Guardrails, output-format contracts, few-shot examples, and security language are
never shortened or dropped in a compact variant; only rarely-needed elaboration and restatement
are. With the key off, behavior is unchanged from before this feature existed.

**How to turn it on:** answer "Yes" to the Compact Content question during `/gsd-new-project`,
or run `/gsd-settings` (or `/gsd-config` with no flag) on an existing project and toggle
Compact Content. See [`docs/CONFIGURATION.md`](CONFIGURATION.md#workflow-toggles) for the
mechanics and [ADR-4139](adr/4139-compact-content-seam.md) for the full design rationale.

---

## Usage Examples

### New Project (Full Cycle)

```bash
claude --dangerously-skip-permissions
/gsd-new-project            # Answer questions, configure, approve roadmap
/clear
/gsd-discuss-phase 1        # Lock in your preferences
/gsd-ui-phase 1             # Design contract (frontend phases)
/gsd-plan-phase 1           # Research + plan + verify
/gsd-execute-phase 1        # Parallel execution
/gsd-verify-work 1          # Manual UAT
/gsd-ship 1                 # Create PR from verified work
/gsd-ui-review 1            # Visual audit (frontend phases)
/clear
/gsd-progress --next                   # Auto-detect and run next step
...
/gsd-audit-milestone        # Check everything shipped
/gsd-complete-milestone     # Archive, tag, done
/gsd-pause-work --report         # Generate session summary
```

`/gsd-ship` also reads the phase's ROADMAP.md record before it opens a PR: the phase must read complete there (checklist entry and progress-table Status), and `jq` must be installed. A phase that is unticked, has no entry, or sits in a progress table that cannot be read is refused with `PHASE_NOT_COMPLETE`, `PHASE_NOT_RECORDED` or `ROADMAP_TABLE_UNREADABLE`; `/gsd-verify-work` completes the phase. Details: [COMMANDS.md](COMMANDS.md#gsd-ship).

> [!CAUTION]
> **The permissions flag is optional.** It skips per-file confirmation while
> GSD's sub-agents read and write files. Use it only in low-stakes or
> throwaway contexts. To keep confirmations enabled, start with `claude` instead.
> For real work, read the [security model](explanation/security-model.md) first.


### New Project from Existing Document

```bash
/gsd-new-project --auto @prd.md   # Auto-runs research/requirements/roadmap from your doc
/clear
/gsd-discuss-phase 1               # Normal flow from here
```

### Existing Codebase

```bash
/gsd-onboard                # Safely map, ingest docs, and initialize planning
# Follow the printed top-level handoff commands, then rerun /gsd-onboard
# (normal phase workflow from here)
```

`/gsd-onboard` routes through `/gsd-map-codebase`, `/gsd-ingest-docs`, and `/gsd-new-project` without nesting interactive workflows or overwriting existing planning files silently.

**Post-execute drift detection (#2003).** After every `/gsd-execute-phase`, GSD checks whether the phase introduced enough structural change to make `.planning/codebase/STRUCTURE.md` stale. Flip the behavior with:

```bash
/gsd-settings workflow.drift_action auto-remap       # remap automatically
/gsd-settings workflow.drift_threshold 5             # tune sensitivity
```

### Plan Drift Guard

The guard is on by default. During plan review it checks that every symbol a plan cites (functions, classes, decorators, CLI flags, module paths) exists in your source, and it reports contradictions between ROADMAP.md, PLAN.md, STATE.md and CONTEXT.md. A missing symbol raises a `needs-acknowledgement` notice you can accept or send back for revision; it never auto-rejects a plan.

```bash
# Enable/disable (default: on)
/gsd-settings plan_review.source_grounding true
/gsd-settings plan_review.source_grounding false

# Switch resolver authority
/gsd-settings plan_review.source_grounding_authority grep   # live grep (default)
/gsd-settings plan_review.source_grounding_authority intel  # pre-indexed api-map.json
```

What each check covers and each resolver value means: [`plan_review.source_grounding`](CONFIGURATION.md#plan-review-settings) and `plan_review.source_grounding_authority`. Why the guard is shaped this way: [ADR 22](adr/22-plan-drift-guard.md).

### Quick Bug Fix

```bash
/gsd-quick
> "Fix the login button not responding on mobile Safari"
```

`/gsd-quick` and `/gsd-fast` log each task to STATE.md's "Quick Tasks Completed" table as a one-line title; the detail stays in the task's SUMMARY.md (or, for `/gsd-fast`, its commit message). A description over 240 characters is still logged in full, with a warning. `/gsd-health` adds the advisory warning `W031` when STATE.md grows past three times its 100-line target. See [`quick-tasks-append`](CLI-TOOLS.md#utility-commands) and [`/gsd-health`](COMMANDS.md#gsd-health).

### Resuming After a Break

```bash
/gsd-progress               # See where you left off and what's next
# or
/gsd-resume-work            # Full context restoration from last session
```

### Preparing for Release

```bash
/gsd-audit-milestone        # Check requirements coverage, detect stubs
/gsd-complete-milestone     # Archive, tag, done
```

### Speed vs Quality Presets

| Scenario    | Mode          | Granularity | Profile    | Research | Plan Check | Verifier |
| ----------- | ------------- | ----------- | ---------- | -------- | ---------- | -------- |
| Prototyping | `yolo`        | `coarse`    | `budget`   | off      | off        | off      |
| Normal dev  | `interactive` | `standard`  | `balanced` | on       | on         | on       |
| Production  | `interactive` | `fine`      | `quality`  | on       | on         | on       |

**Skipping discuss-phase in autonomous mode:** When running in `yolo` mode, set `workflow.skip_discuss: true` via `/gsd-settings`.

### Mid-Milestone Scope Changes

```bash
/gsd-phase                  # Append a new phase to the roadmap (default mode)
/gsd-phase --insert 3       # Insert urgent work between phases 3 and 4
/gsd-phase --remove 7       # Descope phase 7 and renumber
/gsd-phase --edit 4         # Edit any field of phase 4 in place
```

---

## Troubleshooting

For a comprehensive troubleshooting guide, see [Recover and troubleshoot](how-to/recover-and-troubleshoot.md). The most common issues are summarised below.

### Programmatic CLI (`gsd-tools query` vs `gsd-tools.cjs`)

For automation, prefer **`gsd-tools query`** with a registered subcommand (see [CLI-TOOLS.md — SDK and programmatic access](CLI-TOOLS.md#sdk-and-programmatic-access) and QUERY-HANDLERS.md). The legacy `node $HOME/.claude/gsd-core/bin/gsd-tools.cjs` CLI remains supported.

### STATE.md Out of Sync

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state validate          # Detect drift
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state sync --verify     # Preview changes
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state sync              # Reconstruct STATE.md
```

`state validate`'s report carries a `scope` field alongside `valid` — `valid:true` means no drift was found, but `scope` says whether the check could actually run at all (a phase that could not be resolved, or an unreadable frontmatter/phases directory, reports `valid:true` too, because there was nothing to flag). See [Interpret `state validate` results](how-to/interpret-state-validate-results.md) before treating a passing `state validate` as "clean."

### A Command Looks Frozen After "Spawning..."

GSD subagents run in a separate context window — their work is invisible to the parent session while in progress. Do not interrupt the session. Wait for the result; research and planning agents routinely take 1–5 minutes.

### Context Degradation During Long Sessions

Clear your context window between major commands: `/clear` in Claude Code. GSD is designed around fresh contexts — every subagent gets a clean 200K window. Use `/gsd-resume-work` or `/gsd-progress` to restore state after clearing.

### Plans Seem Wrong or Misaligned

Run `/gsd-discuss-phase [N]` before planning. Most plan quality issues come from Claude making assumptions that `CONTEXT.md` would have prevented.

### Execution Fails or Produces Stubs

Check that the plan was not too ambitious. Plans should have 2–3 tasks maximum. Re-plan with smaller scope.

### Lost Track of Where You Are

Run `/gsd-progress`. It reads all state files and tells you exactly where you are and what to do next.

### Model Costs Too High

Switch to the budget profile: `/gsd-config --profile budget`. Disable research and plan-check agents via `/gsd-settings` if the domain is familiar.

To spend by phase type (Opus for planning, Sonnet for the rest), by agent, or to start cheap and escalate on failure, follow [How to configure model profiles](how-to/configure-model-profiles.md): it covers the `models` block, `model_overrides`, `dynamic_routing` and the resolution precedence. The keys are in [Per-Phase-Type Models](CONFIGURATION.md#per-phase-type-models-models--added-in-v140) and [Dynamic Routing](CONFIGURATION.md#dynamic-routing-with-failure-tier-escalation-dynamic_routing--added-in-v140).

Before tuning any of those, trim the MCP servers your harness has enabled: each one adds its tool schema to every turn, and the saving applies to every subagent. This is a harness setting, not a GSD setting, in `.claude/settings.json`:

```json
{
  "enabledMcpjsonServers": ["context7"],
  "disabledMcpjsonServers": ["playwright", "mac-tools"]
}
```

The audit and how it composes with `model_profile` are in [MCP Tool Schema Cost](../gsd-core/references/context-budget.md#mcp-tool-schema-cost-harness-concern).

### Using Non-Claude Runtimes (Codex, OpenCode, Antigravity CLI, Kilo)

If you installed GSD for a non-Claude runtime, the installer already configured model resolution. No manual setup is needed: `resolve_model_ids: "omit"` is set automatically as a Claude protection, and your install's recorded runtime identity tells GSD to skip Anthropic model ID resolution and resolve from the runtime's own model tiers instead.

To assign different models on a non-Claude runtime:

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner": "o3",
    "gsd-executor": "o4-mini",
    "gsd-debugger": "o3"
  }
}
```

To switch a project from Claude to Codex with one config change, set `"runtime": "codex"` as described in [Runtime-Aware Profiles](CONFIGURATION.md#runtime-aware-profiles-2517).

Everything else about a runtime has an owner:

- Per-runtime install steps, the Codex minimum version (0.130.0), Codex agent scheduling and the Qwen skill priority: [How to install GSD Core on your runtime](how-to/install-on-your-runtime.md).
- Moving from OpenCode 1.x to 2.x, and what changes on 2.x: [How to move GSD from OpenCode 1.x to OpenCode 2.x](how-to/upgrade-opencode-1-to-2.md).
- How GSD detects the OpenCode generation, the plugin's two entrypoints, hooks and uninstall: [OpenCode 1.x and 2.x](ARCHITECTURE.md#opencode-1x-and-2x).

### Manual install / no-Node.js setup

If you cannot run the GSD installer, the source files in `agents/` are in Claude Code's native frontmatter format and must be transformed per runtime before they load. The manual-transform walkthrough and the copy-the-output alternative are in [Installing without Node.js](how-to/install-on-your-runtime.md#installing-without-nodejs).

### Using Claude Code with Non-Anthropic Providers

Switch to the `inherit` profile: `/gsd-config --profile inherit`. This makes all agents use your current session model.

### Working on a Sensitive/Private Project

Set `commit_docs: false` during `/gsd-new-project` or via `/gsd-settings`. Add `.planning/` to your `.gitignore`.

### GSD Update Overwrote My Local Changes

Which recovery you need depends on whether you *modified a GSD file* or *added your own*:

- **You edited a file GSD ships** (an agent prompt, a workflow). Since v1.17 the installer backs it up to `gsd-local-patches/`. Run `/gsd-update --reapply` to merge your changes back.
- **You added your own file inside a GSD-managed directory** (a custom skill under `skills/`, an extra file in `commands/gsd/`). The installer saves it to `gsd-user-files-backup/`, and the update offers to restore it once the new version is installed. If you declined, or the backup is left over from an older update, restore it any time:

  ```bash
  node <config-dir>/gsd-core/bin/gsd-tools.cjs restore-custom-files --config-dir <config-dir> --apply
  ```

  Run it without `--apply` first to see what would be restored. The backup is never deleted, and the restore skips any file that would overwrite something the new release ships.

### Install or Refresh a Release Candidate

To install or refresh GSD from the `@next` RC dist-tag (the pre-release channel established by ADR #660), run:

```bash
/gsd-update --next
# or equivalently:
/gsd-update --rc
```

The same scope/runtime detection, changelog preview, custom-file backup, and cache clearing apply. Omitting `--next`/`--rc` keeps targeting `@latest` (stable channel, no change). Only the `@latest` and `@next` channels are supported — no arbitrary dist-tag can be passed.

### Cannot Update via npm

See [docs/manual-update.md](manual-update.md) for a step-by-step manual update procedure.

### Workflow Diagnostics (`/gsd-forensics`)

When a workflow fails in a non-obvious way, run `/gsd-forensics` to generate a diagnostic report covering git history anomalies, artifact integrity, and state inconsistencies. Output goes to `.planning/forensics/`.

### Pre-populated Permissions (Claude Code)

Since v1.3.1, the installer pre-populates `~/.claude/settings.json` (or
`settings.local.json` for local installs) with the core permissions GSD needs:

```json
{
  "permissions": {
    "allow": [
      "Read(.planning/*)",
      "Edit(.planning/*)",
      "Read(STATE.md)",
      "Edit(STATE.md)"
    ]
  }
}
```

These entries eliminate first-run approval prompts for GSD's own tool calls. The
merge is non-destructive — your existing permissions are preserved and GSD entries
are only appended. Uninstalling GSD removes exactly these entries and preserves
any others.

**The unscoped `npx gsd-core` rule is retired (#5054).** Earlier versions also
wrote `Bash(npx gsd-core *)`. GSD is published as `@opengsd/gsd-core`, and the
unscoped `gsd-core` name on npm belongs to a different owner, so that rule let
Claude Code run whatever is published under that name without asking. The next
install or upgrade removes that exact entry; rules you wrote yourself, including
scoped `@opengsd/gsd-core` ones, are kept.
Install and upgrade with `npx @opengsd/gsd-core@latest`.

**Secret-file protection moved from deny rules to a hook (#4221).** Earlier
versions also wrote three `permissions.deny` rules — `Read(.env)`,
`Read(.env.*)` and `Read(.secrets)`. Claude Code 2.1.259 hardened the
Bash-side enforcement of `Read()` deny rules so that *any* such rule makes every
`cd DIR && grep …` / `cd DIR && cat …` compound prompt for approval, even in
`auto` mode — and GSD's subagents emit hundreds of those per session. The same
protection now ships as the always-on `gsd-secret-read-guard.js` PreToolUse hook
(Read, Grep and Bash; see Runtime Hooks above for what it covers and its
documented gaps). A hook denial is not a permission rule, so it never arms that
check, and it applies in `auto` and `bypassPermissions` modes alike. On install
and uninstall the three retired strings are removed from `permissions.deny`
(and an emptied `deny` array is dropped). Note the removal is byte-exact: a
rule you wrote by hand that is identical to one of the three is indistinguishable
from the installer's and is removed as well — re-add it if you want both layers.

### Executor Subagent Gets "Permission denied" on Bash Commands

Add the required patterns to `~/.claude/settings.json`. Core patterns needed for all stacks:

```json
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git merge:*)",
"Bash(git worktree:*)",
"Bash(git rebase:*)",
"Bash(git reset:*)",
"Bash(git checkout:*)",
"Bash(git switch:*)",
"Bash(git restore:*)",
"Bash(git stash:*)",
"Bash(git rm:*)",
"Bash(git mv:*)",
"Bash(git fetch:*)",
"Bash(git cherry-pick:*)",
"Bash(git apply:*)",
"Bash(gh:*)"
```

**Per-project permissions:** add the same `permissions.allow` block to `.claude/settings.local.json` in your project root instead of `~/.claude/settings.json`.

### Parallel Execution Causes Build Lock Errors

GSD handles this automatically since v1.26. If you're on an older version, add to your project's `CLAUDE.md`:

```markdown
## Git Commit Rules for Agents
All subagent/executor commits MUST use `--no-verify`.
```

To disable parallel execution entirely: `/gsd-settings` → set `parallelization.enabled` to `false`.

---

## Recovery Quick Reference

| Problem                              | Solution                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Lost context / new session           | `/gsd-resume-work` or `/gsd-progress`                                    |
| Phase went wrong                     | `git revert` the phase commits, then re-plan                             |
| Need to change scope                 | `/gsd-phase` (default), `/gsd-phase --insert`, or `/gsd-phase --remove`  |
| Something broke                      | `/gsd-debug "description"` (add `--diagnose` for analysis without fixes) |
| STATE.md out of sync                 | `state validate` then `state sync` — check the report's `scope` field, not just `valid` ([interpret results](how-to/interpret-state-validate-results.md)) |
| Workflow state seems corrupted       | `/gsd-forensics`                                                         |
| Quick targeted fix                   | `/gsd-quick`                                                             |
| Plan doesn't match your vision       | `/gsd-discuss-phase [N]` then re-plan                                    |
| Costs running high                   | `/gsd-config --profile budget` and `/gsd-settings` to toggle agents off  |
| Update broke local changes           | `/gsd-update --reapply`                                                  |
| Custom file gone after an update     | `gsd-tools restore-custom-files --config-dir <dir> --apply`              |
| Want session summary for stakeholder | `/gsd-pause-work --report`                                               |
| Don't know what step is next         | `/gsd-progress --next`                                                   |
| Parallel execution build errors      | Update GSD or set `parallelization.enabled: false`                       |

---

## Related

- [Docs index](README.md)
- [Commands](COMMANDS.md)
- [Configuration](CONFIGURATION.md)
- [The phase loop](explanation/the-phase-loop.md)
- [Community Capability Registry & EoS Registry](registries/README.md) — discover third-party Capabilities and EoS host integrations
