# GSD Core Architecture

> System architecture for contributors and advanced users. For user-facing documentation, see [Feature Reference](FEATURES.md) or [User Guide](USER-GUIDE.md).

---

## Table of Contents

- [System Overview](#system-overview)
- [Design Principles](#design-principles)
- [Component Architecture](#component-architecture)
- [Agent Model](#agent-model)
- [Data Flow](#data-flow)
- [File System Layout](#file-system-layout)
- [Installer Architecture](#installer-architecture)
- [Hook System](#hook-system)
- [CLI Tools Layer](#cli-tools-layer)
- [Runtime Abstraction](#runtime-abstraction)

---

## System Overview

GSD Core is a **meta-prompting framework** that sits between the user and AI coding agents (Claude Code, Kimi CLI, OpenCode, Kilo, Codex, Copilot, Antigravity, Trae, Cline, Augment Code). It provides:

1. **Context engineering** — Structured artifacts that give the AI everything it needs per task (see [Context engineering](explanation/context-engineering.md))
2. **Multi-agent orchestration** — Thin orchestrators that spawn specialized agents with fresh context windows (see [Multi-agent orchestration](explanation/multi-agent-orchestration.md))
3. **Spec-driven development** — Requirements → research → plans → execution → verification pipeline
4. **State management** — Persistent project memory across sessions and context resets

```
┌──────────────────────────────────────────────────────┐
│                      USER                            │
│            /gsd-command [args]                        │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│              COMMAND LAYER                            │
│   commands/gsd/*.md — Prompt-based command files      │
│   (Claude Code custom commands / Codex skills)        │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│              WORKFLOW LAYER                           │
│   gsd-core/workflows/*.md — Orchestration logic  │
│   (Reads references, spawns agents, manages state)    │
└──────┬──────────────┬─────────────────┬──────────────┘
       │              │                 │
┌──────▼──────┐ ┌─────▼─────┐ ┌────────▼───────┐
│  AGENT      │ │  AGENT    │ │  AGENT         │
│  (fresh     │ │  (fresh   │ │  (fresh        │
│   context)  │ │   context)│ │   context)     │
└──────┬──────┘ └─────┬─────┘ └────────┬───────┘
       │              │                 │
┌──────▼──────────────▼─────────────────▼──────────────┐
│              CLI TOOLS LAYER                          │
│   gsd-tools.cjs command families + domain modules      │
│   command-routing-hub + observability seams            │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│              FILE SYSTEM (.planning/)                 │
│   PROJECT.md | REQUIREMENTS.md | ROADMAP.md          │
│   STATE.md | config.json | phases/ | research/       │
└──────────────────────────────────────────────────────┘
```

---

## Design Principles

### 1. Fresh Context Per Agent

Every agent spawned by an orchestrator gets a clean context window (up to 200K tokens). This eliminates context rot — the quality degradation that happens as an AI fills its context window with accumulated conversation.

### 2. Thin Orchestrators

Workflow files (`gsd-core/workflows/*.md`) never do heavy lifting. They:

- Load context via `gsd-tools.cjs init <workflow>`
- Spawn specialized agents with focused prompts
- Collect results and route to the next step
- Update state between steps

### 3. File-Based State

All state lives in `.planning/` as human-readable Markdown and JSON. No database, no server, no external dependencies. This means:

- State survives context resets (`/clear`)
- State is inspectable by both humans and agents
- State can be committed to git for team visibility

### 4. Absent = Enabled

Workflow feature flags follow the **absent = enabled** pattern. If a key is missing from `config.json`, it defaults to `true`. Users explicitly disable features; they don't need to enable defaults.

### 5. Defense in Depth

Multiple layers prevent common failure modes:

- Plans are verified before execution (plan-checker agent)
- Execution produces atomic commits per task
- Post-execution verification checks against phase goals
- UAT provides human verification as final gate

---

## Component Architecture

### Commands (`commands/gsd/*.md`)

User-facing entry points. Each file contains YAML frontmatter (name, description, allowed-tools) and a prompt body that bootstraps the workflow. Commands are installed as:

- **Claude Code:** Custom slash commands (hyphen form, `/gsd-command-name`)
- **OpenCode / Kilo:** Slash commands (hyphen form, `/gsd-command-name`)
- **Codex:** Skills (`$gsd-command-name`)
- **Copilot:** Slash commands (hyphen form, `/gsd-command-name`)
- **Kimi CLI:** Agent Skills (`/skill:gsd-command-name`) plus an explicit custom agent launch with `kimi --agent-file`
- **Antigravity:** Skills

**Total commands:** see [`docs/INVENTORY.md`](INVENTORY.md#commands) for the authoritative count and full roster.

#### Two-stage hierarchical routing (v1.40, [#2792](https://github.com/open-gsd/gsd-core/issues/2792))

To keep the eager skill-listing token cost low, v1.40 introduces six namespace **meta-skills** (`gsd-workflow`, `gsd-project`, `gsd-quality`, `gsd-context`, `gsd-manage`, `gsd-ideate` — sourced from `commands/gsd/ns-*.md`, but the invocable `name:` is the bare form shown here) layered above the concrete sub-skills. On runtimes with non-recursive skill loaders (cline, qwen, hermes, augment, trae) the installer now realizes this fully: it emits only the 6 namespace router bundles as top-level skills and nests the ~61 concrete skills under `<router>/skills/<name>/SKILL.md`, so the eager listing is ≈6 entries instead of ≈67. The model selects a namespace router, which instructs it to read the nested concrete skill file via a routing table embedded in the router body. On these runtimes concrete skills are **not** directly invocable by bare name via the Skill tool; they are reachable through the router. Slash commands (`/gsd-*`, via the separate commands surface) are unaffected where the runtime has one. On runtimes with recursive or unconfirmed skill loaders (claude global, cursor, codex, copilot, windsurf, codebuddy, opencode, kilo, antigravity) the layout remains flat — all skills emitted at the top level as before. Antigravity moved from nested to flat in #1614: `agy` scans only `skills/<name>/SKILL.md`, so nested sub-skills were unreachable. Claude was reverted to flat in #924: the Skill tool hard-errors on unknown names rather than re-routing via the router, so nested concrete skills were uninvokable.

The router descriptions use pipe-separated keyword tags (≤ 60 chars) per the Tool Attention research showing keyword-dense tags outperform prose for routing at ~40 % the token cost.

#### MCP token-budget interaction

The eager skill listing is one of two recurring per-turn token costs. The other is the MCP tool schema injected by every enabled MCP server in `.claude/settings.json`. Heavyweight MCP servers (browser/playwright, Mac-tools, Windows-tools) can each cost 20 k+ tokens per turn — often dwarfing what `model_profile` tuning saves. The toggle lives in the Claude Code harness (`enabledMcpjsonServers` / `disabledMcpjsonServers` in `.claude/settings.json`) and is **not** a GSD concern. Together, the two-stage routing layer (#2792) and disciplined MCP enablement are the largest cost levers per turn. See [`docs/USER-GUIDE.md`](USER-GUIDE.md) and `references/context-budget.md` for the audit checklist.

### Workflows (`gsd-core/workflows/*.md`)

Orchestration logic that commands reference. Contains the step-by-step process including:

- Context loading via `gsd-tools.cjs init` handlers
- Agent spawn instructions with model resolution
- Gate/checkpoint definitions
- State update patterns
- Error handling and recovery

**Total workflows:** see [`docs/INVENTORY.md`](INVENTORY.md#workflows) for the authoritative count and full roster.

#### Progressive disclosure for workflows

Workflow files are loaded verbatim into Claude's context every time the
corresponding `/gsd-*` command is invoked. The workflow size budget enforced by
`tests/workflow-size-budget.test.cjs` keeps each file bounded, mirroring the
the agent size-budget convention. The budget is measured in **bytes** (#717), not lines:
line count over-penalizes prose and under-catches token-dense tables and code
blocks, whereas bytes are deterministic and match the unit our vendors bound on
— Codex truncates instruction docs past 32,768 bytes (`project_doc_max_bytes`).
We adopt that unit, not that exact number: the XL/LARGE ceilings below sit above
32,768 because these are grandfathered top-level orchestrators loaded by Claude,
not Codex AGENTS.md docs.

| Tier      | Per-file byte limit |
|-----------|---------------------|
| `XL`      | 90,000 — top-level orchestrators (`execute-phase`, `plan-phase`, `new-project`) |
| `LARGE`   | 54,000 — multi-step planners and large feature workflows |
| `DEFAULT` | 38,000 — focused single-purpose workflows (the target tier) |

Ceilings are not fixed forever: under the tighten-only ratchet (#597) each one
tracks its tier's current high-water mark within a small grace band, so budgets
may only decrease over time.

**Why the budget exists.** With prompt caching the per-invocation *cost* of a
large workflow is modest (cache reads run ~10% of input). The stronger,
caching-independent reason is **quality**: as context grows, recall and
reasoning degrade ("context rot" / attention budget), so leaner, higher-signal
instructions produce better plans. The ceiling protects the agent's attention,
not just the token bill.

Because the budget measures one file, it is a proxy for the real goal —
*bounded loaded context*. Extraction only helps when the extracted content is
loaded **lazily** (Read at the step that needs it). Moving prose into a file
that is still eagerly `@`-imported shrinks the measured file without shrinking
loaded context, which games the proxy rather than serving the goal.

`workflows/discuss-phase.md` is held to a stricter <30,000-byte ceiling per
the discuss-phase byte budget (#717; the discuss-phase/modes split keeps it ≈32000 bytes). When a workflow grows
beyond its tier, extract per-mode bodies into
`workflows/<workflow>/modes/<mode>.md`, templates into
`workflows/<workflow>/templates/`, and shared knowledge into
`gsd-core/references/`. The parent file becomes a thin dispatcher that
Reads only the mode and template files needed for the current invocation.

`workflows/discuss-phase/` is the canonical example of this pattern —
parent dispatches, modes/ holds per-flag behavior (`power.md`, `all.md`,
`auto.md`, `chain.md`, `text.md`, `batch.md`, `analyze.md`, `default.md`,
`advisor.md`), and templates/ holds CONTEXT.md, DISCUSSION-LOG.md, and
checkpoint.json schemas that are read only when the corresponding output
file is being written.

`workflows/plan-phase.md`, `workflows/execute-phase.md`, and the
`gsd-planner` / `gsd-executor` agent definitions apply the same discipline
to their MVP-only reference bodies — `planner-mvp-mode.md`,
`user-story-template.md`, `skeleton-template.md`, and `execute-mvp-tdd.md`
are referenced for the planner/executor to Read only on MVP,
Walking-Skeleton, or MVP+TDD paths, rather than eagerly `@`-imported, so
non-MVP runs do not pay their context cost (guards against the "`@`-import
behind a conditional still loads eagerly" leak; see #720). The dedicated
`mvp-phase` workflow keeps its eager imports, since it is always MVP.

### Agents (`agents/*.md`)

Specialized agent definitions with frontmatter specifying:

- `name` — Agent identifier
- `description` — Role and purpose
- `tools` — Allowed tool access (Read, Write, Edit, Bash, Grep, Glob, WebSearch, etc.)
- `color` — Terminal output color for visual distinction

**Total agents:** 33

### References (`gsd-core/references/*.md`)

Shared knowledge documents that workflows and agents `@-reference` (see [`docs/INVENTORY.md`](INVENTORY.md#references) for the authoritative full roster):

**Core references:**

- `checkpoints.md` — Checkpoint type definitions and interaction patterns
- `gates.md` — 4 canonical gate types (Confirm, Quality, Safety, Transition) wired into plan-checker and verifier
- `model-profiles.md` — Per-agent model tier assignments
- `model-profile-resolution.md` — Model resolution algorithm documentation
- `verification-patterns.md` — How to verify different artifact types
- `verification-overrides.md` — Per-artifact verification override rules
- `planning-config.md` — Full config schema and behavior
- `git-integration.md` — Git commit, branching, and history patterns
- `git-planning-commit.md` — Planning directory commit conventions
- `questioning.md` — Dream extraction philosophy for project initialization
- `tdd.md` — Test-driven development integration patterns
- `ui-brand.md` — Visual output formatting patterns
- `common-bug-patterns.md` — Common bug patterns for code review and verification

**Workflow references:**

- `agent-contracts.md` — Formal interface between orchestrators and agents
- `context-budget.md` — Context window budget allocation rules
- `continuation-format.md` — Session continuation/resume format
- `domain-probes.md` — Domain-specific probing questions for discuss-phase
- `gate-prompts.md` — Gate/checkpoint prompt templates
- `revision-loop.md` — Plan revision iteration patterns
- `universal-anti-patterns.md` — Common anti-patterns to detect and avoid
- `artifact-types.md` — Planning artifact type definitions
- `phase-argument-parsing.md` — Phase argument parsing conventions
- `decimal-phase-calculation.md` — Decimal sub-phase numbering rules
- `workstream-flag.md` — Workstream active pointer conventions
- `user-profiling.md` — User behavioral profiling methodology
- `thinking-partner.md` — Conditional thinking partner activation at decision points

**Thinking model references:**

References for integrating thinking-class models (o3, o4-mini, Gemini 2.5 Pro) into GSD workflows:

- `thinking-models-debug.md` — Thinking model patterns for debugging workflows
- `thinking-models-execution.md` — Thinking model patterns for execution agents
- `thinking-models-planning.md` — Thinking model patterns for planning agents
- `thinking-models-research.md` — Thinking model patterns for research agents
- `thinking-models-verification.md` — Thinking model patterns for verification agents

**Modular planner decomposition:**

The planner agent (`agents/gsd-planner.md`) was decomposed from a single monolithic file into a core agent plus reference modules to stay under the 50K character limit imposed by some runtimes:

- `planner-gap-closure.md` — Gap closure mode behavior (reads VERIFICATION.md, targeted replanning)
- `planner-reviews.md` — Cross-AI review integration (reads REVIEWS.md from `/gsd-review`)
- `planner-revision.md` — Plan revision patterns for iterative refinement

### Templates (`gsd-core/templates/`)

Markdown templates for all planning artifacts. Used by `gsd-tools.cjs template fill` / `phase.scaffold` (and top-level `scaffold`) to create pre-structured files:
- `project.md`, `requirements.md`, `roadmap.md`, `state.md` — Core project files
- `phase-prompt.md` — Phase execution prompt template
- `summary.md` (+ `summary-minimal.md`, `summary-standard.md`, `summary-complex.md`) — Granularity-aware summary templates
- `DEBUG.md` — Debug session tracking template
- `UI-SPEC.md`, `UAT.md`, `VALIDATION.md` — Specialized verification templates
- `discussion-log.md` — Discussion audit trail template
- `codebase/` — Brownfield mapping templates (stack, architecture, conventions, concerns, structure, testing, integrations)
- `research-project/` — Research output templates (SUMMARY, STACK, FEATURES, ARCHITECTURE, PITFALLS)

### Hooks (`hooks/`)

Runtime hooks that integrate with the host AI agent:

| Hook | Event | Purpose |
|------|-------|---------|
| `gsd-statusline.js` | `statusLine` | Displays model, task, directory, and context usage bar |
| `gsd-context-monitor.js` | `PostToolUse` / `AfterTool` | Injects agent-facing context warnings at 35%/25% remaining |
| `gsd-check-update.js` | `SessionStart` | Foreground trigger for the background update check |
| `gsd-ensure-canonical-path.js` | `SessionStart` | For Claude Code plugin installs, symlinks `~/.claude/gsd-core/{bin,contexts,references,templates,workflows}` to the plugin's bundled tree so `@~/.claude/gsd-core/...` includes resolve; runs first in `SessionStart`, no-op in classic installs, self-heals after `claude plugin update` (#997) |
| `gsd-check-update-worker.js` | (helper) | Background worker spawned by `gsd-check-update.js`; no direct event registration |
| `gsd-prompt-guard.js` | `PreToolUse` | Scans `.planning/` writes for prompt injection patterns (advisory) |
| `gsd-read-injection-scanner.js` | `PostToolUse` | Scans Read tool output for injected instructions in untrusted content |
| `gsd-workflow-guard.js` | `PreToolUse` | Detects file edits outside GSD workflow context (advisory, opt-in via `hooks.workflow_guard`) |
| `gsd-read-guard.js` | `PreToolUse` | Advisory guard preventing Edit/Write on files not yet read in the session |
| `gsd-session-state.sh` | `PostToolUse` | Session state tracking for shell-based runtimes |
| `gsd-validate-commit.sh` | `PostToolUse` | Commit validation for conventional commit enforcement |
| `gsd-phase-boundary.sh` | `PostToolUse` | Phase boundary detection for workflow transitions |

See [`docs/INVENTORY.md`](INVENTORY.md#hooks) for the authoritative hook roster.

### Command Routing Hub (`gsd-core/bin/lib/command-routing-hub.cjs`)

CJS command family routers dispatch through `CommandRoutingHub`. The hub owns the no-throw pure-result contract (`hub.dispatch()` catches internal exceptions and returns `{ ok: false, kind, ...typedPayload }`) and the closed runtime error taxonomy (`UnknownCommand`, `InvalidArgs`, `HandlerRefusal`, `HandlerFailure`). Router adapters remain thin CLI translators — they build the hub, call `dispatch`, then map the Result to `output()`/`error()` calls. The runtime is single-path (no dual-runtime mode selection). See `docs/adr/0174-retire-gsd-sdk-package-boundary.md`.

### Capability Command Dispatch (`gsd-core/bin/gsd-tools.cjs`, ADR-1244 D7)

Command families declared by capabilities (`commands: [{ family, module, router }]`) are dispatched from the registry rather than a hardcoded switch. The `runCommand` default arm tries, in order:

1. **First-party** — `dispatchCapabilityCommand` against the frozen `capability-registry.cjs` `commandFamilies`, loading the router from `bin/lib/`. The in-tree families (`graphify`, `intel`, `audit`) reach their routers this way (the legacy hardcoded switch is retired).
2. **Third-party (installed overlay)** — `dispatchOverlayCapabilityCommand` calls `loadRegistry({ includeInstalled })` and dispatches a family only when its `capId` appears in `_overlay.commandRoots`. The loader lists a command root **only** for an accepted overlay capability with a **committed** ledger entry (consent gate), and the router module is `require()`'d **from that capability's install root**, confined by basename validation + `realpath` containment (rejecting `..` traversal and symlink escape). This is the one point where third-party capability code executes; see [the capability trust model](explanation/capability-trust-model.md) for the consent + confinement + project-scope trust boundary.

Both paths share the same guards: prototype-pollution-safe command keys, an own-property router check, and synchronous-only routers (an async router is a fail-fast error).

### Research Module (`src/research-{store,provider}.cts`, `src/package-legitimacy.cts`)

The Research Module implements an **L2-hybrid seam**: code owns the cache, provider policy, and package legitimacy verdicts; MCP owns the actual network fetch.

Three compiled modules (generated to `gsd-core/bin/lib/*.cjs` per ADR-457) are reachable via `gsd-tools query research-plan | research-store | package-legitimacy`:

- **Research Store** — content-addressed cache (`sha256(ecosystem+library+version+query+kind)`) with per-source TTL (curated-doc: 30 d, medium: 7 d, web/synthesis: 1 d) and two storage tiers: `~/.gsd/research-cache` for cross-project curated-doc hits, `.planning/research/.cache` for project-local web/synthesis results.
- **Research Provider** — single `PROVIDER_WATERFALL` (`Context7→Ref→Jina→websearch` for docs; `Exa→Tavily→Perplexity→Brave→websearch` for web; `Firecrawl→Jina` for scrape-only). `planResearch()` returns cache hits plus a fetch plan; `classifyConfidence()` stamps `HIGH|MEDIUM|LOW` by provider tier.
- **Package Legitimacy** — registry-API verdicts (npm/PyPI/crates.io injectable adapters) producing `OK|SUS|SLOP` per package. `slopcheck` is an optional escalate-only adapter; absence leaves registry verdicts intact rather than downgrading everything to `[ASSUMED]`.

**Data flow:**

```
agent
  │
  ▼
gsd-tools query research-plan          ← Research Provider: check cache, build fetch plan
  │
  ├── [cache hits] ──────────────────► RESEARCH.md (digest only, no raw content)
  │
  └── [fetch plan] ──────────────────► MCP fetch (agent calls MCP tools with the plan)
                                          │
                                          ▼
                                    gsd-tools query research-store (put)
                                          │
                                          ▼
                                    RESEARCH.md path returned to orchestrator
```

Agents always return a `RESEARCH.md` path, never raw fetched content. Context discipline is enforced through subagent isolation, compact provider output, and fetch-to-disk. See [ADR-0656](adr/0656-research-module-seam.md).

### CLI Tools (`gsd-core/bin/`)

Node.js CLI utility (`gsd-tools.cjs`) with domain modules split across `gsd-core/bin/lib/` (see [`docs/INVENTORY.md`](INVENTORY.md#cli-modules) for the authoritative roster):


| Module                 | Responsibility                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `config-loader.cjs`    | Project config loading — defaults merge, legacy-key migration, workstream overlay, unknown-key/profile-override validation, and federated config overlay (ADR-857 phase 3b) (extracted from `core.cjs`, ADR-857) |
| `federated-config.cjs` | Defensive merge of capability-declared config slices (ADR-857 phase 3b); exports `mergeFederatedConfig`; live for migrated Capability keys that are absent from the central config schema |
| `core-utils.cjs`       | Shared low-level utility primitives — POSIX path normalization, sub-repo/subdirectory scanning, phase file stats, slug/one-liner/plan-id helpers, time-ago (extracted from `core.cjs`, ADR-857) |
| `core.cjs`             | Shared utilities; compatibility re-exports for planning, I/O (`io.cjs`), and phase-id helpers       |
| `io.cjs`               | CLI I/O primitives — output/error emission, JSON-error mode, large-payload temp-file spillover     |
| `phase-id.cjs`         | Pure phase-id parsing/matching helpers — normalize, token match, regex builders (extracted from `core.cjs`, ADR-857) |
| `phase-locator.cjs`    | Phase-directory search and location — active-phase discovery (`searchPhaseInDir`, `findPhaseInternal`) and archived-phase-dir enumeration (`getArchivedPhaseDirs`), matching phase ids/tokens against the filesystem (extracted from `core.cjs`, ADR-857) |
| `roadmap-parser.cjs`   | ROADMAP.md parsing — milestone slicing, current-milestone extraction, phase/milestone lookups, milestone-phase filter (extracted from `core.cjs`, ADR-857) |
| `planning-workspace.cjs` | Planning seam (`planningDir`, `planningPaths`, active workstream routing, `.planning/.lock`)      |
| `state.cjs`            | STATE.md parsing, updating, progression, metrics                                                    |
| `phase.cjs`            | Phase directory operations, decimal numbering, plan indexing                                        |
| `roadmap.cjs`          | ROADMAP.md parsing, phase extraction, plan progress                                                 |
| `config.cjs`           | config.json read/write, section initialization                                                      |
| `verify.cjs`           | Plan structure, phase completeness, reference, commit validation                                    |
| `template.cjs`         | Template selection and filling with variable substitution                                           |
| `frontmatter.cjs`      | YAML frontmatter CRUD operations                                                                    |
| `init.cjs`             | Compound context loading for each workflow type                                                     |
| `milestone.cjs`        | Milestone archival, requirements marking                                                            |
| `commands.cjs`         | Misc commands (slug, timestamp, todos, scaffolding, stats)                                          |
| `model-profiles.cjs`   | Model profile resolution table                                                                      |
| `model-resolver.cjs`   | Model and effort resolution policy — resolves model, tier, granularity, effort, and fast-mode for a given agent from project config and model profiles/catalog (extracted from `core.cjs`, ADR-857) |
| `security.cjs`         | Path traversal prevention, prompt injection detection, safe JSON parsing, shell argument validation |
| `uat.cjs`              | UAT file parsing, verification debt tracking, audit-uat support                                     |
| `docs.cjs`             | Docs-update workflow init, Markdown scanning, monorepo detection                                    |
| `workstream.cjs`       | Workstream CRUD, migration, session-scoped active pointer                                           |
| `schema-detect.cjs`    | Schema-drift detection for ORM patterns (Prisma, Drizzle, etc.)                                     |
| `profile-pipeline.cjs` | User behavioral profiling data pipeline, session file scanning                                      |
| `profile-output.cjs`       | Profile rendering, USER-PROFILE.md and dev-preferences.md generation                                |
| `loop-host-contract.cjs`   | Generated Loop Host Contract — 12 loop points, per-step agent roles, and core artifacts; emitted by `scripts/gen-loop-host-contract.cjs` from workflow markers (ADR-894 §3); consumed by `gen-capability-registry.cjs` |
| `capability-loader.cjs`    | Runtime registry overlay loader (ADR-1244 D2) — `loadRegistry({ includeInstalled })` composes the frozen first-party registry with a validated installed overlay of third-party capability manifests read from global `$GSD_HOME/.gsd/capabilities/` and project `<projectRoot>/.gsd/capabilities/`; first-party always wins; load-time `engines.gsd` re-gate skips incompatible overlays with a warning; gate-kind hooks on skipped capabilities fail CLOSED |
| `capability-registry.cjs`  | Generated central Capability Registry — role-partitioned index of all co-located capability declarations; emitted by `scripts/gen-capability-registry.cjs` (ADR-894 §5) |
| `loop-resolver.cjs`        | Loop Extension Point resolver — ADR-857 phase 3c registry-consuming query; consumes resolved Capability State, filters `byLoopPoint` by capability enablement plus config activation, renders active hooks as markdown, emits `{ point, activeHooks, rendered }` envelope; `gsd-tools loop render-hooks <point> [--config-dir <path>]` |
| `capability-state.cjs`     | Unified capability-state resolver — ADR-857 phase 4b/6; composes install profile, runtime surface, and config activation into one per-capability view consumed by workflow hook rendering; pure `resolveCapabilityState`, reusable `resolveCapabilityRuntimeState`, I/O `cmdCapabilityState`, and convenience predicate `isCapabilityActive(capId, cwd)`; `gsd-tools capability state [--config-dir <path>]` emits `{ runtimeConfigDir, capabilities[] }` where each entry carries `enabled` (installed && surfaced) and `active` (enabled && configActivation via the capability's `activationKey`; absent key → active===enabled) |
| `capability-validator.cjs` | Shared capability conformance validator (ADR-1244 D2) — extracted from `scripts/gen-capability-registry.cjs` so the build-time generator and the runtime overlay loader share one `validateCapability(manifest)` implementation; generative-parity is CI-guarded |
| `graphify-command-router.cjs` | ADR-959 capability command router — first real capability command cutover (phase 4d-impl-2); extracted from the `case 'graphify':` arm in `gsd-tools.cjs`; dispatches build/query/status/diff subcommands; discovered via `commandFamilies` in the capability registry |
| `audit-command-router.cjs` | ADR-959 capability command router (phase 4d-impl-3); extracted from the `case 'audit-uat':` and `case 'audit-open':` arms in `gsd-tools.cjs`; `routeAuditUat` → `uat.cjs:cmdAuditUat`, `routeAuditOpen` → `audit.cjs:{auditOpenArtifacts,formatAuditReport}`; discovered via `commandFamilies` in the capability registry |
| `intel-command-router.cjs` | ADR-959 capability command router (phase 4d-impl-4, last first-party cutover); extracted from the `case 'intel':` arm in `gsd-tools.cjs`; `routeIntelCommand` → all 9 intel subcommands via lazy `require('./intel.cjs')`; preserves non-raw `timeAgo` transform on `status.files[*].updated_at`; discovered via `commandFamilies` in the capability registry |
| `runtime-hooks-surface.cjs` | Standalone hook-surface writer module (ADR-857 phase 5f-1); owns Cline rules/agents-md/pre-tool-use hook generation, Cursor `hooks.json` reconciliation, Copilot session-hook config, and Codex hook-block management; extracted verbatim from `bin/install.js` with no logic change. |


---

## Agent Model

### Orchestrator → Agent Pattern

```
Orchestrator (workflow .md)
    │
    ├── Load context: gsd-tools.cjs init <workflow> <phase>
    │   Returns JSON with: project info, config, state, phase details
    │
    ├── Resolve model: gsd-tools.cjs resolve-model <agent-name>
    │   Returns: opus | sonnet | haiku | inherit
    │
    ├── Spawn Agent (Task/SubAgent call)
    │   ├── Agent prompt (agents/*.md)
    │   ├── Context payload (init JSON)
    │   ├── Model assignment
    │   └── Tool permissions
    │
    ├── Collect result
    │
    └── Update state: gsd-tools.cjs state update / state patch / state advance-plan
```

### Primary Agent Spawn Categories

Conceptual spawn-pattern taxonomy for the primary agents. For the authoritative agent roster (including the advanced/specialized agents such as `gsd-pattern-mapper`, `gsd-code-reviewer`, `gsd-code-fixer`, `gsd-ai-researcher`, `gsd-domain-researcher`, `gsd-eval-planner`, `gsd-eval-auditor`, `gsd-framework-selector`, `gsd-debug-session-manager`, `gsd-intel-updater`), see [`docs/INVENTORY.md`](INVENTORY.md#agents).


| Category         | Agents                                                                                  | Parallelism                                                                               |
| ---------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Researchers**  | gsd-project-researcher, gsd-phase-researcher, gsd-ui-researcher, gsd-advisor-researcher | 4 parallel (stack, features, architecture, pitfalls); advisor spawns during discuss-phase |
| **Synthesizers** | gsd-research-synthesizer                                                                | Sequential (after researchers complete)                                                   |
| **Planners**     | gsd-planner, gsd-roadmapper                                                             | Sequential                                                                                |
| **Checkers**     | gsd-plan-checker, gsd-integration-checker, gsd-ui-checker, gsd-nyquist-auditor          | Sequential (verification loop, max 3 iterations)                                          |
| **Executors**    | gsd-executor                                                                            | Parallel within waves, sequential across waves                                            |
| **Verifiers**    | gsd-verifier                                                                            | Sequential (after all executors complete)                                                 |
| **Mappers**      | gsd-codebase-mapper                                                                     | 4 parallel (tech, arch, quality, concerns)                                                |
| **Debuggers**    | gsd-debugger                                                                            | Sequential (interactive)                                                                  |
| **Auditors**     | gsd-ui-auditor, gsd-security-auditor                                                    | Sequential                                                                                |
| **Doc Writers**  | gsd-doc-writer, gsd-doc-verifier                                                        | Sequential (writer then verifier)                                                         |
| **Profilers**    | gsd-user-profiler                                                                       | Sequential                                                                                |
| **Analyzers**    | gsd-assumptions-analyzer                                                                | Sequential (during discuss-phase)                                                         |


### Wave Execution Model

During `execute-phase`, plans are grouped into dependency waves:

```
Wave Analysis:
  Plan 01 (no deps)      ─┐
  Plan 02 (no deps)      ─┤── Wave 1 (parallel)
  Plan 03 (depends: 01)  ─┤── Wave 2 (waits for Wave 1)
  Plan 04 (depends: 02)  ─┘
  Plan 05 (depends: 03,04) ── Wave 3 (waits for Wave 2)
```

Each executor gets:

- Fresh 200K context window (or up to 1M for models that support it)
- The specific PLAN.md to execute
- Project context (PROJECT.md, STATE.md)
- Phase context (CONTEXT.md, RESEARCH.md if available)

### Adaptive Context Enrichment (1M Models)

When the context window is 500K+ tokens (1M-class models like Opus 4.6, Sonnet 4.6), subagent prompts are automatically enriched with additional context that would not fit in standard 200K windows:

- **Executor agents** receive prior wave SUMMARY.md files and the phase CONTEXT.md/RESEARCH.md, enabling cross-plan awareness within a phase
- **Verifier agents** receive all PLAN.md, SUMMARY.md, CONTEXT.md files plus REQUIREMENTS.md, enabling history-aware verification

The orchestrator reads `context_window` from config (`gsd-tools.cjs config-get context_window`) and conditionally includes richer context when the value is >= 500,000. For standard 200K windows, prompts use truncated versions with cache-friendly ordering to maximize context efficiency.

#### Parallel Commit Safety

When multiple executors run within the same wave, two mechanisms prevent conflicts:

1. `--no-verify` commits — Parallel agents skip pre-commit hooks (which can cause build lock contention, e.g., cargo lock fights in Rust projects). The orchestrator runs `git hook run pre-commit` once after each wave completes.
2. **STATE.md file locking** — All `writeStateMd()` calls use lockfile-based mutual exclusion (`STATE.md.lock` with `O_EXCL` atomic creation). This prevents the read-modify-write race condition where two agents read STATE.md, modify different fields, and the last writer overwrites the other's changes. Includes stale lock detection (10s timeout) and spin-wait with jitter.

---

## Data Flow

### New Project Flow

```
User input (idea description)
    │
    ▼
Questions (questioning.md philosophy)
    │
    ▼
4x Project Researchers (parallel)
    ├── Stack → STACK.md
    ├── Features → FEATURES.md
    ├── Architecture → ARCHITECTURE.md
    └── Pitfalls → PITFALLS.md
    │
    ▼
Research Synthesizer → SUMMARY.md
    │
    ▼
Requirements extraction → REQUIREMENTS.md
    │
    ▼
Roadmapper → ROADMAP.md
    │
    ▼
User approval → STATE.md initialized
```

### Phase Execution Flow

```
discuss-phase → CONTEXT.md (user preferences)
    │
    ▼
ui-phase → UI-SPEC.md (design contract, optional)
    │
    ▼
plan-phase
    ├── Research gate (blocks if RESEARCH.md has unresolved open questions)
    ├── Phase Researcher → RESEARCH.md
    │       └── Package Legitimacy Gate: slopcheck on every package; [SLOP] removed,
    │           [SUS]/[ASSUMED] flagged; Audit table written to RESEARCH.md
    ├── Planner (with reachability check) → PLAN.md files
    │       └── checkpoint:human-verify injected before [ASSUMED]/[SUS] installs;
    │           T-{phase}-SC STRIDE row added for install-bearing plans
    ├── Plan Checker → Verify loop (max 3x)
    ├── Requirements coverage gate (REQ-IDs → plans)
    └── Decision coverage gate (CONTEXT.md `<decisions>` → plans, BLOCKING — #2492)
    │
    ▼
state planned-phase → STATE.md (Planned/Ready to execute)
    │
    ▼
execute-phase (context reduction: truncated prompts, cache-friendly ordering)
    ├── Wave analysis (dependency grouping)
    ├── Executor per plan → code + atomic commits
    ├── SUMMARY.md per plan
    └── Verifier → VERIFICATION.md
        └── Decision coverage gate (CONTEXT.md decisions → shipped artifacts, NON-BLOCKING — #2492)
    │
    ▼
verify-work → UAT.md (user acceptance testing)
    │
    ▼
ui-review → UI-REVIEW.md (visual audit, optional)
```

### Context Propagation

Each workflow stage produces artifacts that feed into subsequent stages:

```
PROJECT.md ────────────────────────────────────────────► All agents
REQUIREMENTS.md ───────────────────────────────────────► Planner, Verifier, Auditor
ROADMAP.md ────────────────────────────────────────────► Orchestrators
STATE.md ──────────────────────────────────────────────► All agents (decisions, blockers)
CONTEXT.md (per phase) ────────────────────────────────► Researcher, Planner, Executor
RESEARCH.md (per phase) ───────────────────────────────► Planner, Plan Checker
PLAN.md (per plan) ────────────────────────────────────► Executor, Plan Checker
SUMMARY.md (per plan) ─────────────────────────────────► Verifier, State tracking
UI-SPEC.md (per phase) ────────────────────────────────► Executor, UI Auditor
```

---

## File System Layout

### Installation Files

```
~/.claude/                          # Claude Code (global install)
├── skills/gsd-ns-*/SKILL.md        # Global skills — nesting runtimes: 6 namespace routers (authoritative roster: docs/INVENTORY.md)
│   └── skills/<name>/SKILL.md     #   concrete skills nested under each router
│   (flat runtimes: skills/gsd-*/SKILL.md — all ~67 skills at top level)
├── commands/gsd/*.md               # Local Claude installs use slash commands instead of global skills
├── gsd-core/
│   ├── bin/gsd-tools.cjs           # CLI utility
│   ├── bin/lib/*.cjs               # Domain modules (authoritative roster: docs/INVENTORY.md)
│   ├── workflows/*.md              # Workflow definitions (authoritative roster: docs/INVENTORY.md)
│   ├── references/*.md             # Shared reference docs (authoritative roster: docs/INVENTORY.md)
│   └── templates/                  # Planning artifact templates
├── agents/*.md                     # Agent definitions (authoritative roster: docs/INVENTORY.md)
├── hooks/*.js                      # Node.js hooks (statusline, guards, monitors, update check)
├── hooks/*.sh                      # Shell hooks (session state, commit validation, phase boundary)
├── settings.json                   # Hook registrations
└── VERSION                         # Installed version number
```

Equivalent paths for other runtimes:

- **OpenCode:** `~/.config/opencode/` global or `./.opencode/` local
- **Kilo:** `~/.config/kilo/` global or `./.kilo/` local
- **Kimi CLI:** first-existing generic global root (`~/.config/agents/` recommended, then `~/.agents/` if its `skills/` directory already exists); local install is deferred and guarded
- **Codex:** `~/.codex/` global or `./.codex/` local
- **Copilot:** `~/.copilot/` global or `./.github/` local
- **Antigravity:** auto-detected global root (`~/.gemini/antigravity/`, `~/.gemini/antigravity-ide/`, or `~/.gemini/antigravity-cli/`) or `./.agent/` local
- **Cursor:** `~/.cursor/` global or `./.cursor/` local
- **Windsurf/Devin Desktop:** `~/.codeium/windsurf/` global config or `./.windsurf/` local workflows
- **Augment Code:** `~/.augment/` global or `./.augment/` local
- **Trae:** `~/.trae/` global or `./.trae/` local
- **Qwen Code:** `~/.qwen/` global or `./.qwen/` local
- **Hermes Agent:** `~/.hermes/` global or `./.hermes/` local
- **CodeBuddy:** `~/.codebuddy/` global or `./.codebuddy/` local
- **Cline:** `~/.cline/` global or project-root `.clinerules` local

### Project Files (`.planning/`)

```
.planning/
├── PROJECT.md              # Project vision, constraints, decisions, evolution rules
├── REQUIREMENTS.md         # Scoped requirements (v1/v2/out-of-scope)
├── ROADMAP.md              # Phase breakdown with status tracking
├── STATE.md                # Living memory: position, decisions, blockers, metrics
├── config.json             # Workflow configuration
├── MILESTONES.md           # Completed milestone archive
├── research/               # Domain research from /gsd-new-project
│   ├── SUMMARY.md
│   ├── STACK.md
│   ├── FEATURES.md
│   ├── ARCHITECTURE.md
│   └── PITFALLS.md
├── codebase/               # Brownfield mapping (from /gsd-map-codebase)
│   ├── STACK.md            # YAML frontmatter carries `last_mapped_commit`
│   ├── ARCHITECTURE.md     # for the post-execute drift gate (#2003)
│   ├── CONVENTIONS.md
│   ├── CONCERNS.md
│   ├── STRUCTURE.md
│   ├── TESTING.md
│   └── INTEGRATIONS.md
├── phases/
│   └── XX-phase-name/
│       ├── XX-CONTEXT.md       # User preferences (from discuss-phase)
│       ├── XX-RESEARCH.md      # Ecosystem research (from plan-phase)
│       ├── XX-YY-PLAN.md       # Execution plans
│       ├── XX-YY-SUMMARY.md    # Execution outcomes
│       ├── XX-VERIFICATION.md  # Post-execution verification
│       ├── XX-VALIDATION.md    # Nyquist test coverage mapping
│       ├── XX-UI-SPEC.md       # UI design contract (from ui-phase)
│       ├── XX-UI-REVIEW.md     # Visual audit scores (from ui-review)
│       └── XX-UAT.md           # User acceptance test results
├── quick/                  # Quick task tracking
│   └── YYMMDD-xxx-slug/
│       ├── PLAN.md
│       └── SUMMARY.md
├── todos/
│   ├── pending/            # Captured ideas
│   └── done/               # Completed todos
├── threads/               # Persistent context threads (from /gsd-thread)
├── seeds/                 # Forward-looking ideas (from /gsd-capture --seed)
├── debug/                  # Active debug sessions
│   ├── *.md                # Active sessions
│   ├── resolved/           # Archived sessions
│   └── knowledge-base.md   # Persistent debug learnings
├── ui-reviews/             # Screenshots from /gsd-ui-review (gitignored)
└── continue-here.md        # Context handoff (from pause-work)
```

### Post-Execute Codebase Drift Gate (#2003)

After the last wave of `/gsd-execute-phase` commits, the workflow runs a
non-blocking `codebase_drift_gate` step (between `schema_drift_gate` and
`verify_phase_goal`). It compares the diff `last_mapped_commit..HEAD`
against `.planning/codebase/STRUCTURE.md` and counts four kinds of
structural elements:

1. New directories outside mapped paths
2. New barrel exports at `(packages|apps)/<name>/src/index.*`
3. New migration files
4. New route modules under `routes/` or `api/`

If the count meets `workflow.drift_threshold` (default 3), the gate either
**warns** (default) with the suggested `/gsd-map-codebase --paths …` command,
or **auto-remaps** (`workflow.drift_action = auto-remap`) by spawning
`gsd-codebase-mapper` scoped to the affected paths. Any error in detection
or remap is logged and the phase continues — drift detection cannot fail
verification.

`last_mapped_commit` lives in YAML frontmatter at the top of each
`.planning/codebase/*.md` file; `bin/lib/drift.cjs` provides
`readMappedCommit` and `writeMappedCommit` round-trip helpers.

---

## Installer Architecture

The installer (`bin/install.js`, ~10,700 lines) handles:

1. **Runtime detection** — Interactive prompt or CLI flags (`--claude`, `--opencode`, `--kimi`, `--kilo`, `--codex`, `--copilot`, `--antigravity`, `--cursor`, `--windsurf`, `--augment`, `--trae`, `--qwen`, `--hermes`, `--codebuddy`, `--cline`, `--all`)
2. **Location selection** — Global (`--global`) or local (`--local`)
3. **File deployment** — Copies commands, skills, workflows, references, templates, agents, and hooks
4. **Runtime adaptation** — Transforms file content per runtime:
  - Claude Code: Uses as-is
  - OpenCode: Converts commands/agents to OpenCode-compatible flat command + subagent format
  - Kilo: Reuses the OpenCode conversion pipeline with Kilo config paths
  - Codex: Generates TOML config + skills from commands
  - Kimi CLI: Generates Agent Skills under `skills/gsd-*/SKILL.md`, custom agent YAML/prompt files, and explicit `kimi_cli.tools.*` module paths
  - Copilot: Maps tool names (Read→read, Bash→execute, etc.)
  - Antigravity: Skills-first with Google model equivalents; adjusts hook event names (`AfterTool` instead of `PostToolUse`)
  - Cursor: Skills-first with Cursor rule references
  - Windsurf: Skills-first with Windsurf rule references
  - Trae: Skills-first install to `~/.trae` / `./.trae` with no `settings.json` or hook integration
  - Qwen Code: Skills-first with Qwen-branded path and prompt rewrites
  - Hermes Agent: Category-based skills under `skills/gsd/`
  - CodeBuddy: Skills-first with CodeBuddy path and prompt rewrites
  - Cline: Writes `.clinerules` for rule-based integration
  - Augment Code: Skills-first with full skill conversion and config management
5. **Path normalization** — Replaces `~/.claude/` paths with runtime-specific paths
6. **Settings integration** — Registers hooks in runtime's `settings.json`
7. **Patch backup** — Since v1.17, backs up locally modified files to `gsd-local-patches/` for `/gsd-update --reapply`
8. **Manifest tracking** — Writes `gsd-file-manifest.json` for clean uninstall
9. **Uninstall mode** — `--uninstall` removes all GSD files, hooks, and settings

Install-time file moves, stale-artifact cleanup, config rewrites, and user-data
preservation are governed by the Installer Migration Module. See
[Installer Migrations](installer-migrations.md) and
[ADR 0008](adr/0008-installer-migration-module.md).
The migration module also owns the gated first-time baseline scan for legacy
installs, classifying known runtime install surfaces before later migrations
remove or rewrite anything.

The plan drift guard (`plan_review.source_grounding`) — which verifies symbol references in generated plans against live source before execution — is specified in [ADR 22](adr/22-plan-drift-guard.md).

### Platform Handling

- **Windows:** `windowsHide` on child processes, EPERM/EACCES protection on protected directories, path separator normalization
- **WSL:** Detects Windows Node.js running on WSL and warns about path mismatches
- **Docker/CI:** Supports `CLAUDE_CONFIG_DIR` env var for custom config directory locations

---

## Hook System

### Architecture

```
Runtime Engine (Claude Code / Antigravity CLI)
    │
    ├── statusLine event ──► gsd-statusline.js
    │   Reads: stdin (session JSON)
    │   Writes: stdout (formatted status), /tmp/claude-ctx-{session}.json (bridge)
    │
    ├── PostToolUse/AfterTool event ──► gsd-context-monitor.js
    │   Reads: stdin (tool event JSON), /tmp/claude-ctx-{session}.json (bridge)
    │   Writes: stdout (hookSpecificOutput with additionalContext warning)
    │
    └── SessionStart event
        ├──► gsd-ensure-canonical-path.js   (runs first)
        │    Reads:  ${CLAUDE_PLUGIN_ROOT}/gsd-core/ (plugin installs only)
        │    Writes: ~/.claude/gsd-core/{bin,contexts,references,templates,workflows} symlinks
        │            (no-op in classic installs; preserves user files; self-heals)
        └──► gsd-check-update.js
             Reads:  VERSION file
             Writes: ~/.claude/cache/gsd-update-check.json (spawns background process)
```

### Context Monitor Thresholds


| Remaining Context | Level    | Agent Behavior                          |
| ----------------- | -------- | --------------------------------------- |
| > 35%             | Normal   | No warning injected                     |
| ≤ 35%             | WARNING  | "Avoid starting new complex work"       |
| ≤ 25%             | CRITICAL | "Context nearly exhausted, inform user" |


Debounce: 5 tool uses between repeated warnings. Severity escalation (WARNING→CRITICAL) bypasses debounce.

### Safety Properties

- All hooks wrap in try/catch, exit silently on error
- stdin timeout guard (3s) prevents hanging on pipe issues
- Stale metrics (>60s old) are ignored
- Missing bridge files handled gracefully (subagents, fresh sessions)
- Context monitor is advisory — never issues imperative commands that override user preferences

### Package Legitimacy Gate (v1.42.1)

The researcher → planner → executor pipeline includes a supply-chain gate against slopsquatting (AI-hallucinated package names pre-registered with malicious post-install scripts).

**Threat model:** GSD automates the full path from "researcher names a package" to "executor runs `npm install`". A hallucinated name that passes `npm view` (proving only registration, not legitimacy) would previously flow through undetected. ~20% of AI-generated package references are hallucinated; ~43% of those names recur consistently across prompts, making pre-registration economically viable for attackers.

**Gate layers:**

| Layer | Component | Action |
|-------|-----------|--------|
| Research | `gsd-phase-researcher` | Runs `slopcheck install <pkgs> --json`; writes `## Package Legitimacy Audit` table to RESEARCH.md; strips `[SLOP]` packages before RESEARCH.md is written |
| Planning | `gsd-planner` | Reads Audit table; inserts `checkpoint:human-verify` before any `[ASSUMED]` or `[SUS]` install task; adds `T-{phase}-SC` STRIDE supply-chain row to `<threat_model>` |
| Execution | `gsd-executor` | RULE 3 excludes package installation from auto-fix scope; failed installs surface as checkpoints, never silent substitutions |

**Claim provenance integration:** Package names discovered via WebSearch are tagged `[ASSUMED]` (not `[VERIFIED]`) regardless of `npm view` result. This extends the existing `[ASSUMED]` / `[VERIFIED]` / `[CITED]` provenance system by enforcing the provenance tag as a hard gate at the install boundary — `[ASSUMED]` always generates a `checkpoint:human-verify` in PLAN.md.

**Ecosystem coverage:** The researcher uses registry-specific verification commands — `npm view` (Node), `pip index versions` (Python), `cargo search` (Rust) — rather than a single generic check. This catches cross-ecosystem hallucination (~9% rate documented in 2025 USENIX research).

**Graceful degradation:** If `slopcheck` is unavailable, every recommended package is tagged `[ASSUMED]` and gated with a checkpoint. Research and planning proceed; the system never hard-fails on a missing tool dependency.

**External dependency:** `slopcheck` (MIT, pip-installable). If abandoned, the `[ASSUMED]`-gate fallback maintains human-checkpoint coverage.

---

### Security Hooks (v1.27)

For a conceptual overview of how the hook and guard layers fit into the broader security approach, see [Security model](explanation/security-model.md).

**Prompt Guard** (`gsd-prompt-guard.js`):

- Triggers on Write/Edit to `.planning/` files
- Scans content for prompt injection patterns (role override, instruction bypass, system tag injection)
- Advisory-only — logs detection, does not block
- Patterns are inlined (subset of `security.cjs`) for hook independence

**Workflow Guard** (`gsd-workflow-guard.js`):

- Triggers on Write/Edit to non-`.planning/` files
- Detects edits outside GSD workflow context (no active `/gsd-` command or Task subagent)
- Advises using `/gsd-quick` or `/gsd-fast` for state-tracked changes
- Opt-in via `hooks.workflow_guard: true` (default: false)

---

## Runtime Abstraction

GSD supports multiple AI coding runtimes through a unified command/workflow architecture:

### Runtime Install Contract Matrix

This matrix describes the runtime surfaces the installer materializes today.
The migration-specific ownership and source snapshots live in
[Installer Migrations](installer-migrations.md#runtime-configuration-contract-registry).

| Runtime | Global root | Local root | Invocation surface | Agent surface | Config and hooks |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `~/.claude` | `./.claude` | Global `skills/gsd-*/SKILL.md` (flat, #924); local `commands/gsd/*.md` | `agents/gsd-*.md` | `settings.json` hook and statusLine entries |
| OpenCode | `~/.config/opencode` | `./.opencode` | `command/gsd-*.md` | `agents/gsd-*.md` | `opencode.json` or `opencode.jsonc`; no GSD hooks |
| Kilo | `~/.config/kilo` | `./.kilo` | `command/gsd-*.md` | `agents/gsd-*.md` | `kilo.json` or `kilo.jsonc`; no GSD hooks |
| Kimi CLI | First-existing generic root: `~/.config/agents` recommended, then `~/.agents` when `~/.agents/skills` exists and `~/.config/agents/skills` does not | Deferred and guarded | `skills/gsd-*/SKILL.md` (flat) invoked as `/skill:gsd-*` | `agents/gsd.yaml`, `agents/gsd.md`, and `agents/subagents/gsd-*` YAML/prompt pairs | Explicit `kimi --agent-file <configRoot>/agents/gsd.yaml`; no GSD hooks or statusline |
| Codex | `~/.codex` | `./.codex` | `skills/gsd-*/SKILL.md` (flat) | `agents/` source markdown plus per-agent TOML | `config.toml` `[agents.gsd-*]`, `[features].hooks` (canonical; legacy alias `codex_hooks` is recognized and migrated forward on reinstall, #3566), and hook tables |
| GitHub Copilot | `~/.copilot` | `./.github` | `skills/gsd-*/SKILL.md` (flat), `copilot-instructions.md`, and `AGENTS.md` (repo root, local) | `.agent.md` files | Self-contained `sessionStart` hook (`hooks/gsd-session.json`, inline `command` type); no statusline |
| Antigravity | auto-detected: `~/.gemini/antigravity`, `~/.gemini/antigravity-ide`, or `~/.gemini/antigravity-cli` | `./.agent` | `skills/gsd-*/SKILL.md` (flat, #1614) | `agents/gsd-*.md` | Gemini-style `settings.json` hook entries when installed by GSD |
| Cursor | `~/.cursor` | `./.cursor` | `skills/gsd-*/SKILL.md` (flat) | `agents/gsd-*.md` | Rule references under `rules/`; `hooks.json` with sessionStart context injection and postToolUse STATE.md monitor (#777) |
| Windsurf | `~/.codeium/windsurf` config | `./.windsurf` | `workflows/gsd-*.md` slash-command workflows | No custom-agent artifact surface | No GSD hooks |
| Augment Code | `~/.augment` | `./.augment` | `skills/gsd-ns-*/SKILL.md` (6 routers) + `skills/gsd-ns-*/skills/<name>/SKILL.md` (nested concretes) | `agents/gsd-*.md` | No GSD hooks or statusline |
| Trae | `~/.trae` | `./.trae` | `skills/gsd-ns-*/SKILL.md` (6 routers) + `skills/gsd-ns-*/skills/<name>/SKILL.md` (nested concretes) | `agents/gsd-*.md` | Rule references under `rules/`; no GSD hooks |
| Qwen Code | `~/.qwen` | `./.qwen` | `skills/gsd-ns-*/SKILL.md` (6 routers) + `skills/gsd-ns-*/skills/<name>/SKILL.md` (nested concretes) | `agents/gsd-*.md` | Common GSD settings and hook entries where supported |
| Hermes Agent | `~/.hermes` | `./.hermes` | `skills/gsd/ns-*/SKILL.md` (6 routers, prefix='') + `skills/gsd/ns-*/skills/<name>/SKILL.md` (nested concretes) | `agents/gsd-*.md` | Common GSD settings and hook entries where supported |
| CodeBuddy | `~/.codebuddy` | `./.codebuddy` | `skills/gsd-*/SKILL.md` (flat, `user-invocable: false`) | `agents/gsd-*.md` | `/gsd-*` slash commands under `commands/`; common GSD settings and hook entries where supported |
| Cline | `~/.cline` | project root | `skills/gsd-ns-*/SKILL.md` (6 routers) + `skills/gsd-ns-*/skills/<name>/SKILL.md` (nested concretes) + `.clinerules` | Rules only | No GSD hooks or statusline |

### Upstream Contract Sources

Runtime install expectations are checked against primary documentation where
available. The current source snapshot is 2026-05-11, with Kimi CLI rechecked
on 2026-06-07:

- Claude Code: Anthropic slash commands, settings, hooks, and subagents docs.
- OpenCode and Kilo: OpenCode config docs and Kilo custom subagent docs.
- Qwen Code: command/config docs; Qwen command docs were last
  updated 2026-05-06.
- Kimi CLI: Agent Skills docs for user-level brand roots and first-existing
  generic roots (`~/.config/agents/skills/` recommended, then
  `~/.agents/skills/`), plus Agents docs for YAML files, `system_prompt_path`,
  `kimi_cli.tools.*` module paths, and explicit `kimi --agent-file` launch.
- Codex: OpenAI Codex docs and `config-schema.json`; the installer also carries
  Codex 0.124.0 compatibility for agent table shape.
- Copilot, Cursor, Cline, Augment, Hermes, and CodeBuddy: vendor docs for
  custom instructions, rules, skills, or config.
- Antigravity, Windsurf, and Trae: source-limited rows. The installer documents
  current compatibility shims, and migrations must refresh those sources before
  rewriting their config.

### Abstraction Points

1. **Tool name mapping** — Each runtime has its own tool names (e.g., Claude's `Bash` → Copilot's `execute`)
2. **Hook event names** — Claude uses `PostToolUse`, Antigravity uses `AfterTool`
3. **Agent frontmatter** — Each runtime has its own agent definition format
4. **Path conventions** — Each runtime stores config in different directories
5. **Model references** — `inherit` profile lets GSD defer to runtime's model selection

The installer handles all translation at install time. Workflows and agents are written in Claude Code's native format and transformed during deployment.

---

## Related

- [Multi-agent orchestration](explanation/multi-agent-orchestration.md)
- [Security model](explanation/security-model.md)
- [CLI tools](CLI-TOOLS.md)
- [docs index](README.md)
