# GSD Core Architecture

> System architecture for contributors and advanced users. For user-facing documentation, see [Feature Reference](FEATURES.md) or [User Guide](USER-GUIDE.md).

---

## Table of Contents

- [System Overview](#system-overview)
- [Design Principles](#design-principles)
- [Component Architecture](#component-architecture)
- [Agent Model](#agent-model)
- [Data Flow](#data-flow)
- [Installer Architecture](#installer-architecture)
- [Hook System](#hook-system)
- [CLI Tools](#cli-tools-gsd-corebin)
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

To keep the eager skill-listing token cost low, v1.40 introduces six namespace **meta-skills** (`gsd-workflow`, `gsd-project`, `gsd-quality`, `gsd-context`, `gsd-manage`, `gsd-ideate` — sourced from `commands/gsd/ns-*.md`, but the invocable `name:` is the bare form shown here) layered above the concrete sub-skills. On runtimes with non-recursive skill loaders (cline, qwen, hermes, augment, trae) the installer now realizes this fully: it emits only the 6 namespace router bundles as top-level skills and nests the 66 concrete skills under `<router>/skills/<name>/SKILL.md`, so the eager listing is ≈6 entries instead of 72. The model selects a namespace router, which instructs it to read the nested concrete skill file via a routing table embedded in the router body. On these runtimes concrete skills are **not** directly invocable by bare name via the Skill tool; they are reachable through the router. Slash commands (`/gsd-*`, via the separate commands surface) are unaffected where the runtime has one. On runtimes with recursive or unconfirmed skill loaders (claude global, cursor, codex, copilot, windsurf, codebuddy, opencode, kilo, antigravity) the layout remains flat — all skills emitted at the top level as before. Antigravity moved from nested to flat in #1614: `agy` scans only `skills/<name>/SKILL.md`, so nested sub-skills were unreachable. Claude was reverted to flat in #924: the Skill tool hard-errors on unknown names rather than re-routing via the router, so nested concrete skills were uninvokable.

The router bundles and what each routes to:

| Namespace | Router bundle | Routes to |
|-----------|--------------|-----------|
| Phase pipeline | `gsd-ns-workflow` | discuss / plan / execute / verify / phase / progress |
| Project lifecycle | `gsd-ns-project` | milestones, audits, summary |
| Quality gates | `gsd-ns-review` | code review, debug, audit, security, eval, ui |
| Codebase intelligence | `gsd-ns-context` | map, graphify, docs, learnings |
| Exploration & capture | `gsd-ns-ideate` | explore, sketch, spike, spec, capture |
| Management | `gsd-ns-manage` | config, workspace, workstreams, thread, update, ship, inbox |

**Migration note (breaking change on the five nesting runtimes).** Upgrading to v1.40 changes skill invocation behaviour on Cline, Qwen, Hermes, Augment and Trae:

- **Before:** each of the ~67 concrete `gsd-<name>` skills appeared at the top level and was invocable by bare name through the Skill tool.
- **After:** only the 6 `gsd-ns-*` router bundles appear at the top level. Concrete skills are reachable via the router's routing table and a `Read skills/<name>/SKILL.md` call. Direct bare-name invocation of concrete skills through the Skill tool's listing no longer works.
- **Slash commands unchanged:** `/gsd-plan-phase`, `/gsd-discuss-phase`, etc. still work directly where a commands surface is installed.
- **Upgrade prune:** the installer's existing prune step removes the legacy top-level `gsd-<concrete>/` skill directories on upgrade — no manual cleanup is needed.

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

Shared knowledge documents that workflows and agents `@-reference`. The authoritative roster, with one line per reference, is in [`docs/INVENTORY.md`](INVENTORY.md#references).

The planner agent (`agents/gsd-planner.md`) was decomposed from a single monolithic file into a core agent plus reference modules (`planner-gap-closure.md`, `planner-reviews.md`, `planner-revision.md`) to stay under the 50K character limit imposed by some runtimes.

### Templates (`gsd-core/templates/`)

Markdown templates for all planning artifacts, used by `gsd-tools.cjs template fill` / `phase.scaffold` (and top-level `scaffold`) to create pre-structured files. The catalog is in [Templates](reference/templates.md).

### Hooks (`hooks/`)

Runtime hooks that integrate with the host AI agent. The authoritative hook roster, with each hook's event and purpose, is in [`docs/INVENTORY.md`](INVENTORY.md#hooks), and the security hooks are specified in [Security hooks](reference/security-hooks.md). The statusline collapses long-context model suffixes such as `(1M context)` into a compact `(1M)` badge.

**Crash policy (ADR-3889 Phase 7, #3911).** Every enforcement hook terminates
through `hooks/lib/hook-exit.js`'s `allow(payload)` (exit 0), `deny(payload,
stderrPayload?)` (exit 2), or `crash(onCrash, payload, stderrPayload?)` — the last
dispatching per a `HOOK_ON_CRASH` policy the hook must declare explicitly (`ALLOW` or
`DENY`, no default), so a hook's fail-open/fail-closed stance is a visible
declaration rather than an inference from a bare `process.exit(N)`. Two hooks
are deliberate exceptions — `gsd-read-injection-scanner.js` (PostToolUse) and
`gsd-cursor-subagent-start.js` (Cursor) — whose harnesses read the block
decision from the JSON response body at exit 0, not from the exit code, so
they never call `deny()`. See
[Declare a hook's crash policy](how-to/declare-a-hook-crash-policy.md).

### Command Routing Hub (`gsd-core/bin/lib/command-routing-hub.cjs`)

CJS command family routers dispatch through `CommandRoutingHub`. The hub owns the no-throw pure-result contract (`hub.dispatch()` catches internal exceptions and returns `{ ok: false, kind, ...typedPayload }`) and the closed runtime error taxonomy (`UnknownCommand`, `InvalidArgs`, `HandlerRefusal`, `HandlerFailure`, and `VerificationStatusInvalid` — a handler that read a verification report whose `status` is outside the closed set; the adapter fails with the error's own reason, `verification_status_invalid`). Router adapters remain thin CLI translators — they build the hub, call `dispatch`, then map the Result to `output()`/`error()` calls. The runtime is single-path (no dual-runtime mode selection). See `docs/adr/0174-retire-gsd-sdk-package-boundary.md`.

> **Planned (ADR-2346 / epic #2345):** the `runCommand` 73-case switch is being dissolved into a two-layer dispatch — families via the `commandFamilies` registry (ADR-959 mechanism, completed) and single-purpose leaf verbs via a table filling the prepared `_dispatchNonFamily` seam — collapsing `runCommand` to a ~15-line dispatcher. Behavior-preserving; tracked phase-by-phase under epic #2345. The current-state description above holds until each phase lands.

### Check Gate Modules (`src/gate-*.cts`, `src/check-command-router.cts`, #5139, epic #5056)

Every `gsd-tools check <gate>` verb is a module that returns a value; the router only turns that value into output. Each gate module (`gate-decision-coverage-plan`, `gate-decision-coverage-verify`, `gate-ui-plan`, `gate-ui-safety`, `gate-tdd-review-checkpoint`, `gate-tdd-red-evidence`, `gate-verify-command-paths`, `gate-verify-failure-directions`, `gate-gap-analysis-plan-post`, `gate-predicate`, `gate-api-coverage-verify-pre`, and, since #5219 (ADR-5057 §4), `gate-schema-drift`, `gate-codebase-drift`, `gate-context-drift` and `gate-prohibition-enforcement`) returns a `GateResult` from `gate-verdict`: a `GateVerdict` (`outcome`, `block`, a frozen ordered `payload`) or a `GateUsageFailure`. `GATE_FAILURE_CODE` is the closed set of failure codes.

The gate roster, support modules, ESLint boundaries and the behavior differences from the pre-refactor router are in [Check gate modules](reference/check-gate-modules.md); the design is [ADR-5057](adr/5057-one-owner-per-workflow-verdict.md), and the roster is in [`docs/INVENTORY.md`](INVENTORY.md).

### Evaluation Scope Resolver (`src/gate-evaluation-scope.cts`, #5164, epic #5056, ADR-5057 §4)

"Which commits and which files does this gate or workflow step evaluate?" has one owner. Before it existed, `code-review`, `quick`, `execute-plan`, `execute-phase`, the `gsd-code-reviewer` agents, `ui-safety-gate`, `tdd-review-checkpoint`, `decision-coverage-verify` and `verify schema-drift` each derived their own answer (`HEAD~1..HEAD`, `DIFF_BASE..HEAD`, `git log --all`), and the answers disagreed with each other and with the work they meant to scope.

The verb is a resolver, not a policy: it always reports `block: false`, and the caller decides what a `degraded` or `unresolvable` scope means. The returned fields, design rules, `sub_repos` handling and CLI flags are in [Evaluation scope resolver reference](reference/evaluation-scope.md).

### Capability Command Dispatch (`gsd-core/bin/gsd-tools.cjs`, ADR-1244 D7)

Command families declared by capabilities (`commands: [{ family, module, router }]`) are dispatched from the registry rather than a hardcoded switch. The `runCommand` default arm tries, in order:

1. **First-party** — `dispatchCapabilityCommand` against the frozen `capability-registry.cjs` `commandFamilies`, loading the router from `bin/lib/`. The in-tree families (`graphify`, `intel`, `audit`) reach their routers this way (the legacy hardcoded switch is retired).
2. **Third-party (installed overlay)** — `dispatchOverlayCapabilityCommand` calls `loadRegistry({ includeInstalled })` and dispatches a family only when its `capId` appears in `_overlay.commandRoots`. The loader lists a command root **only** for an accepted overlay capability with a **committed** ledger entry (consent gate), and the router module is `require()`'d **from that capability's install root**, confined by basename validation + `realpath` containment (rejecting `..` traversal and symlink escape). This is the one point where third-party capability code executes; see [the capability trust model](explanation/capability-trust-model.md) for the consent + confinement + project-scope trust boundary.

Both paths share the same guards: prototype-pollution-safe command keys, an own-property router check, and synchronous-only routers (an async router is a fail-fast error).

### Reviewer-Lane Capability Trait (#4209, ADR-2782)

`/gsd-code-review` optionally corroborates its internal review with external reviewer lanes (`--codex`, `--agy`, ...), gated by the reusable `supportsReviewerLanes` capability-step trait and dispatched through the single `dispatchReviewerLanes` interpreter — see `gsd-core/references/loop-hook-dispatch.md` for the trait and `src/reviewer-step-dispatch.cts` for the interpreter's fail-closed contract. `gsd-code-reviewer` is the sole consolidator: it independently re-verifies every external claim against the actual source before writing anything to `REVIEW.md`, so a lane's evidence is corroborating input, never a second output schema.

### Research Module (`src/research-{store,provider}.cts`, `src/package-legitimacy.cts`)

The Research Module implements an **L2-hybrid seam**: code owns the cache, provider policy, and package legitimacy verdicts; MCP owns the actual network fetch.

Three compiled modules (generated to `gsd-core/bin/lib/*.cjs` per ADR-457) are reachable via `gsd-tools query research-plan | research-store | package-legitimacy`: a content-addressed Research Store, a Research Provider with one provider waterfall, and Package Legitimacy registry verdicts. The cache key, TTL tiers and waterfall are in [ADR-0656](adr/0656-research-module-seam.md) and the provider tiers are in [CLI Tools](CLI-TOOLS.md).

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

### Context Predicate Fact-Store (`src/context-predicates.cts`, ADR-1671)

The `CONTEXT.md` predicate fact-store — every backtick-wrapped `CLASS.subkey=value` declaration in the repo-root `CONTEXT.md` — has a compiled parser/selector seam (generated to `gsd-core/bin/lib/context-predicates.cjs` per ADR-457) reachable live via `gsd-tools query context-predicates --class|--prefix|--contains`. Fence-aware line skipping mirrors `markdown-sectionizer.cts`'s exported `scanFencedBlocks` delimiter-matching rule exactly (proven by a fence-skip parity test suite), but is scanned by a LOCAL, interleaved single pass rather than a call into that seam directly: fences and HTML comments must mutually suppress each other's open/close detection while either is active (a fence delimiter inside a real comment, or a comment token inside a real fence, must not falsely toggle the other construct), and that precedence cannot be resolved by two independent passes over `scanFencedBlocks`'s comment-blind output — see `src/context-predicates.cts`'s module doc comment.

The committed index carries no `line` field (ADR-1671, resolved by #2928); see [ADR-1671](adr/1671-dynamic-context-management-platform.md) and [CLI Tools](CLI-TOOLS.md) for the selector surface.

### Workflow Fragmentization and Emission (`src/workflow-fragments.cts`, ADR-1671)

Workflows are authored as fragments with marker comments and emitted as whole files at build time. The marker grammar, vocabulary and the set of fragmented workflows are in [Workflow fragments](reference/workflow-fragments.md); the design is [ADR-1671](adr/1671-dynamic-context-management-platform.md).

### Section Manifest (`src/section-manifest.cts`, ADR-1671 Phases 5 and 6.1)

`section-manifest.json` and the `selectSections` selector are specified in [Workflow fragments](reference/workflow-fragments.md) and listed in [`docs/INVENTORY.md`](INVENTORY.md).

### CLI Tools (`gsd-core/bin/`)

`gsd-tools.cjs` is the single CLI entry point. Its modules are listed with their roles in [`docs/INVENTORY.md`](INVENTORY.md#cli-modules).

`gsd-tools.cjs` requires each of these modules on first use (#5865). A command loads the modules it runs, plus the ones every command goes through before dispatch: those `main()` uses first (`cli-exit`, `io`, `project-root`, `project-context`, `cli-skew-check`, `active-workstream-store`, `cli-surface`, and what they require) and the capability-dispatch stack (`capability-registry`, `capability-loader` and theirs). `runtime-identity` loads 32 `lib/` modules, where every command used to load about 220.


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

The spawn-pattern taxonomy (researchers, synthesizers, planners, checkers, executors, verifiers, mappers and the rest) and each category's parallelism are in [Multi-agent orchestration](explanation/multi-agent-orchestration.md); the authoritative roster is in [`docs/AGENTS.md`](AGENTS.md) and [Agents](reference/agents.md).

### Wave Execution Model

During `execute-phase`, plans are grouped into dependency waves: plans with no dependency run in parallel in Wave 1, and a plan that depends on another waits for the earlier wave. Each executor gets a fresh context window, its PLAN.md, the project context and the phase context. The diagram and rules are in [Multi-agent orchestration](explanation/multi-agent-orchestration.md).

### Adaptive Context Enrichment (1M Models)

When the context window is 500K+ tokens (1M-class models like Opus 4.6, Sonnet 4.6), subagent prompts are automatically enriched with additional context that would not fit in standard 200K windows:

- **Executor agents** receive prior wave SUMMARY.md files and the phase CONTEXT.md/RESEARCH.md, enabling cross-plan awareness within a phase
- **Verifier agents** receive all PLAN.md, SUMMARY.md, CONTEXT.md files plus REQUIREMENTS.md, enabling history-aware verification

The orchestrator reads `context_window` from config (`gsd-tools.cjs config-get context_window`) and conditionally includes richer context when the value is >= 500,000. For standard 200K windows, prompts use truncated versions with cache-friendly ordering to maximize context efficiency.

#### Parallel Commit Safety

Parallel executors in one wave skip pre-commit hooks (the orchestrator validates once per wave) and serialize `STATE.md` writes behind a lockfile; see [Multi-agent orchestration](explanation/multi-agent-orchestration.md).

#### The STATE.md Write Path

Locking decides *who* writes. A separate contract decides *what survives the write*.

STATE.md carries the same fact in two places — YAML frontmatter and the document body — and the body is authoritative. Every write therefore re-derives frontmatter from the body, which raises the question the write path exists to answer: when a re-derived value disagrees with the one already in frontmatter, which wins?

`FIELD_CLASSIFICATION` (`src/state-transition.cts`) answers it per field, declaring a `preservation` policy — `preserve-when-unchanged`, `preserve-always`, `preserve-if-placeholder`, `derive` — that `applyStatePreservation` executes after `syncStateFrontmatter` re-derives. (A fifth policy, `clear`, was listed here until ADR-3408 §8.6's amendment removed it: no row used it and no executor existed for it.)

The pre-write snapshot a policy compares against travels as a `StateTransaction` (`openStateTransaction()`, or `rebuildStateTransaction()` for the closed exception list: `state sync` and `/gsd-health --repair`'s factory reset), so the precondition is a type, not a convention (ADR-3473 §8.6). Every `state.*` command returns an `updated` array derived by comparing what was persisted against that snapshot: a field appears if, and only if, its persisted value changed, at dotted-leaf granularity (`progress.total_plans`, not `progress`; ADR-3473 §8.7).

One field is excluded, and it is excluded for its *provenance* rather than its policy: `last_updated` is stamped on every save regardless of what you changed, so admitting it would make `state patch`'s success signal — which is simply whether `updated` is non-empty — permanently true, and a patch in which every field failed would report success. `state_head` is deliberately **not** excluded: it is recomputed on every save but only *changes* when the commit it records actually moved, so reporting it tells you something true.

A practical consequence worth knowing: these arrays are now longer than they used to be, because they used to under-report. If you compare one exactly, expect more entries — and expect them to be the ones that really changed.

**[ADR-3408](adr/3408-state-write-path-preservation.md) is the normative contract** for that path: one executor per declared policy, one write seam, and reports computed from what was actually persisted rather than from what the caller intended to write. Where the contract and the code disagree, the code is the defect. It is the write-side counterpart of [ADR-3180](adr/3180-planning-semantic-model-single-owner.md), which gave each read-side derivation a single owner.

**[ADR-3473](adr/3473-enforcement-by-construction.md) owns the invariants that sit outside that contract.** ADR-3408 governs what survives a write; it does not govern the pipeline's precondition, what a command reports it wrote, or where the set of STATE.md keys, types and enums is declared. ADR-3473 owns those, alongside document parsing, enumeration, and the return contract of every routine that can fail. It is the third application of ADR-3180's mechanism and the first whose success metric requires the guard surface to *shrink* as each seam lands.

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
    │       └── Package Legitimacy Gate: registry-API verdict on every package; [SLOP] removed,
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

The baseline stamp is written by a shell step, not the mapper agent, and an absent baseline is skipped rather than reported as drift; see [Why the codebase drift gate is built the way it is](explanation/codebase-drift-gate-design.md). The element table, skip reasons and `stamp-codebase-map` are in [CLI Tools](CLI-TOOLS.md#verify-codebase-drift-structural-drift-of-the-codebase-map-2003-5134).

---

## Installer Architecture

The installer (`bin/install.js`, ~10,700 lines) handles:

1. **Runtime detection** — Interactive prompt or CLI flags (the flag list is in [Installer flags](reference/installer-flags.md))
2. **Location selection** — Global (`--global`) or local (`--local`)
3. **File deployment** — Copies commands, skills, workflows, references, templates, agents, and hooks
4. **Runtime adaptation** — Transforms file content per runtime (Claude Code uses it as-is; the per-runtime conversions and install surfaces are in [Installer migrations](installer-migrations.md) and [Runtime install contracts](reference/runtime-install-contracts.md))
5. **Path normalization** — Replaces `~/.claude/` paths with runtime-specific paths
6. **Settings integration** — Registers hooks in runtime's `settings.json`
7. **Patch backup** — Since v1.17, backs up locally modified files to `gsd-local-patches/` for `/gsd-update --reapply`
8. **Manifest tracking** — Writes `gsd-file-manifest.json` for clean uninstall. The manifest also records which `runtime` and which `scope` (`global`/`local`) wrote it, under a `manifestVersion` schema field, so a reader can answer "which surfaces are installed, at which scopes" without inferring it from the directory the file sits in ([ADR 2866](adr/2866-install-surface-resolution.md), #2872). Manifests written before that carry no such fields and are read without error — no reinstall is required. See [Installer Migrations → File Manifest](installer-migrations.md#file-manifest)
9. **Uninstall mode** — `--uninstall` removes all GSD files, hooks, and settings

`installRuntimeArtifacts` (`install-engine.cjs`) returns the executed plan it ran — per kind, per
scope, including on the combined OpenCode/Kilo family path, which previously early-returned `void` —
rather than being observable only by re-reading disk afterward. Its destination-writing IO (copies,
removals, snapshot/restore, best-effort cleanup) now routes through an injectable fs seam,
`install-fs-adapter.cjs`, so a full install can be exercised against a fake adapter with zero real
destination IO; locating this package's own source tree remains real by design (a destination-fake
is never seeded with the repo's own paths). Writes stay byte-identical and existing `void`-ignoring
callers are unaffected. This completes [ADR 58](adr/58-runtime-install-policy-module.md)'s
`registry → adapter → helpers → cleanup` rollout — the `cleanup` step had not previously landed
(#2874, epic #2866 Phase 5).

Install-time file moves, stale-artifact cleanup, config rewrites, and user-data
preservation are governed by the Installer Migration Module. See
[Installer Migrations](installer-migrations.md) and
[ADR 0008](adr/0008-installer-migration-module.md).
The migration module also owns the gated first-time baseline scan for legacy
installs, classifying known runtime install surfaces before later migrations
remove or rewrite anything.

The plan drift guard (`plan_review.source_grounding`) — which verifies symbol references in generated plans against live source before execution — is specified in [ADR 22](adr/22-plan-drift-guard.md).

`plan_review.source_grounding` also gates a second, cross-artifact fact-drift axis; both are described in [Configuration](CONFIGURATION.md#plan-review-settings).

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

The two fire-points are defaults. `hooks.context_warning_threshold` and
`hooks.context_critical_threshold` in `.planning/config.json` move them per
project; see [How to tune the context monitor's fire-points](how-to/tune-the-context-monitor.md)
for the steps and [context-monitor.md](context-monitor.md) for the threshold
table, the measurement scale, and the fallback rules.

### Safety Properties

Advisory hooks wrap in try/catch and exit silently on error; enforcement hooks take the crash policy they declare (see the crash policy under Hooks above). Stale metrics (older than 60s) are ignored ([Context monitor](context-monitor.md)), and the context monitor is advisory. The per-hook stdin timeouts and the subagent early-exit are in [Security hooks](reference/security-hooks.md#hook-safety-properties).

### Package Legitimacy Gate (v1.42.1)

The researcher → planner → executor pipeline includes a supply-chain gate against slopsquatting (AI-hallucinated package names pre-registered with malicious post-install scripts). The threat model, why web-search packages are always `[ASSUMED]` (which extends the `[ASSUMED]` / `[VERIFIED]` / `[CITED]` provenance system), the registry coverage and the degraded-registry behavior are explained in [Layer 1 of the security model](explanation/security-model.md#layer-1--supply-chain-protection-the-package-legitimacy-gate).

**Gate layers:**

| Layer | Component | Action |
|-------|-----------|--------|
| Research | `gsd-phase-researcher` | Runs `gsd-tools query package-legitimacy check --ecosystem <npm\|pypi\|crates> <pkgs>`; writes `## Package Legitimacy Audit` table to RESEARCH.md; strips `[SLOP]` packages before RESEARCH.md is written |
| Planning | `gsd-planner` | Reads Audit table; inserts `checkpoint:human-verify` before any `[ASSUMED]` or `[SUS]` install task; adds `T-{phase}-SC` STRIDE supply-chain row to `<threat_model>` |
| Execution | `gsd-executor` | RULE 3 excludes package installation from auto-fix scope; failed installs surface as checkpoints, never silent substitutions |

---

### Security Hooks (v1.27)

For a conceptual overview of how the hook and guard layers fit into the broader security approach, see [Security model](explanation/security-model.md).

The per-hook behavior, rule ids, thresholds and output contracts are in [Security hooks](reference/security-hooks.md#hook-specifications).

---

## Runtime Abstraction

GSD supports multiple AI coding runtimes through a unified command/workflow architecture:

The installed file layout, the per-runtime install contract matrix, and the
upstream documentation each row was checked against are described in
[Runtime install contracts](reference/runtime-install-contracts.md).

### OpenCode 1.x and 2.x

One `opencode` runtime serves OpenCode 1.x and 2.x ([ADR-5331](adr/5331-opencode-v2-support-and-v1-sunset.md)). How GSD detects the generation, builds spawn arguments, installs and uninstalls on each is in [How GSD runs on OpenCode](explanation/how-gsd-runs-on-opencode.md).

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
- [Runtime install contracts](reference/runtime-install-contracts.md) — the installed file layout, the per-runtime matrix and its upstream sources
- [Planning artifacts](reference/planning-artifacts.md) — every `.planning/` file and its role
- [docs index](README.md)
