# Multi-agent orchestration in GSD Core

> **Explanation** — This document describes *why* GSD Core is designed around
> multi-agent orchestration and *how the pieces fit together*. It is not a
> step-by-step guide. For configuration, see
> [Configure model profiles](../how-to/configure-model-profiles.md) and the
> [Configuration reference](../CONFIGURATION.md). For the full agent roster,
> see [Inventory](../INVENTORY.md).

---

## The problem this design solves

AI coding agents degrade. Not because the model gets worse, but because the
*context window fills up*. As a conversation grows, earlier decisions and code
get pushed out or diluted by the noise of intermediate steps. By the time an
agent writes the fifth file in a complex task, it may have already forgotten
the constraint stated in the first message. This is sometimes called *context
rot*.

GSD Core's multi-agent design is a direct response to that problem. Instead of
one long-running agent carrying the whole session, a thin orchestrator spawns
short-lived specialised agents, each with a **fresh 200 K-token context window**
and *only the artifacts it needs* to do its specific job. The orchestrator
never does heavy lifting itself; it loads context, spawns the right agent,
collects the result, and updates shared state in `.planning/`.

---

## The orchestrator → agent pattern

Every workflow in `get-shit-done/workflows/` follows the same shape:

```text
Orchestrator (workflow .md file)
    │
    ├── Load context
    │   gsd-tools.cjs init <workflow> <phase>
    │   → JSON: project info, config, state, phase details
    │
    ├── Resolve model
    │   gsd-tools.cjs resolve-model <agent-name>
    │   → opus | sonnet | haiku | inherit
    │
    ├── Spawn specialised agent (Task/SubAgent call)
    │   ├── Agent definition (agents/*.md)
    │   ├── Context payload (init JSON)
    │   ├── Model assignment
    │   └── Tool permissions
    │
    ├── Collect result
    │
    └── Update state
        gsd-tools.cjs state update / state patch / state advance-plan
```

The orchestrator is deliberately thin. It does not reason about the domain,
does not write code, and does not interpret results beyond routing them to the
next step. That boundary keeps each layer's responsibility clear and prevents
the orchestrator's context from accumulating domain noise.

### The agent roster

GSD Core's agents fall into functional categories that map onto the
research → plan → execute → verify pipeline:

| Category | Agents | Typical parallelism |
|---|---|---|
| Researchers | `gsd-project-researcher`, `gsd-phase-researcher`, `gsd-ui-researcher`, `gsd-advisor-researcher` | 4 parallel (stack, features, architecture, pitfalls) |
| Synthesisers | `gsd-research-synthesizer` | Sequential, after researchers complete |
| Planners | `gsd-planner`, `gsd-roadmapper` | Sequential |
| Checkers | `gsd-plan-checker`, `gsd-integration-checker`, `gsd-ui-checker`, `gsd-nyquist-auditor` | Sequential, up to 3 revision iterations |
| Executors | `gsd-executor` | Parallel within a wave, sequential across waves |
| Verifiers | `gsd-verifier` | Sequential, after all executors complete |
| Mappers | `gsd-codebase-mapper` | 4 parallel sub-probes |
| Auditors | `gsd-ui-auditor`, `gsd-security-auditor` | Sequential |

Each agent definition (in `agents/*.md`) declares its allowed tool access,
purpose, and colour for terminal output. An agent that only needs to read files
and write a single output document gets exactly those permissions — no Bash
execution, no access to broader state. That constraint is intentional: it
keeps the blast radius small if an agent behaves unexpectedly.

For the complete 31-agent roster, see [Inventory](../INVENTORY.md#agents-31-shipped).

---

## Wave-based parallel execution

The most visible expression of multi-agent design is how `/gsd-execute-phase`
handles a set of plans that may depend on one another.

Before spawning any executor, the orchestrator performs a **wave analysis**:
it reads the dependency declarations in each `PLAN.md` file and groups plans
into waves. Plans with no declared dependencies form Wave 1 and run in
parallel. Plans that depend on Wave 1 form Wave 2, and so on.

```text
Plan 01 (no deps)        ─┐
Plan 02 (no deps)        ─┤─── Wave 1  (parallel)
Plan 03 (depends: 01)    ─┤─── Wave 2  (waits for Wave 1)
Plan 04 (depends: 02)    ─┘
Plan 05 (depends: 03, 04) ─── Wave 3  (waits for Wave 2)
```

Each executor within a wave:

- receives a fresh context window (200 K tokens, or up to 1 M on capable models)
- receives the specific `PLAN.md` it is responsible for
- receives project context (`PROJECT.md`, `STATE.md`)
- receives phase context (`CONTEXT.md`, `RESEARCH.md` if available)
- produces atomic git commits on completion
- writes a `SUMMARY.md` describing what was built

After all executors in a wave finish, the orchestrator runs the pre-commit
hook once for the wave as a whole. Executors commit with `--no-verify` to
prevent build-lock contention (for example, Cargo lock fights in Rust
projects) when multiple agents commit in parallel. The hook therefore runs
once per wave rather than once per commit.

### Parallel commit safety

Two mechanisms prevent write conflicts when multiple executors run
simultaneously:

1. **Atomic lock on `STATE.md`** — Every write to `STATE.md` uses a
   lockfile (`STATE.md.lock`) with `O_EXCL` atomic creation. This prevents
   the read-modify-write race where two agents each read the file, modify
   different fields, and the later writer overwrites the earlier one's
   changes. Stale locks (older than 10 seconds) are automatically cleared.

2. **Per-wave hook run** — Rather than each executor running pre-commit hooks
   independently (which can cause file-level contention on shared build
   artefacts), the orchestrator runs `git hook run pre-commit` once after
   every wave completes.

---

## Adaptive context enrichment for large-window models

Standard 200 K context windows are enough for an executor to implement a
single focused plan. When the configured `context_window` is 500 K tokens or
larger (for example, when using Opus 4.6 or Sonnet 4.6 in 1 M-class mode),
the orchestrator automatically enriches subagent prompts with additional
context that would not fit in a standard window:

- **Executor agents** receive prior-wave `SUMMARY.md` files and the phase
  `CONTEXT.md`/`RESEARCH.md`, giving them cross-plan awareness within the
  phase
- **Verifier agents** receive all `PLAN.md`, `SUMMARY.md`, and `CONTEXT.md`
  files plus `REQUIREMENTS.md`, enabling history-aware verification

This enrichment is conditional on the `context_window` value in
`config.json`. On standard-window configurations, prompts use truncated
versions with cache-friendly ordering to maximise token efficiency.

---

## Why this design — the connection to context engineering

The orchestrator → agent pattern only makes sense as part of a broader
approach to *context engineering*: the idea that what an AI agent gets in its
context window matters as much as the model tier or prompt quality. See
[Context engineering](context-engineering.md) for the full treatment.

Multi-agent orchestration operationalises context engineering in two ways:

**Context isolation.** Each agent receives only what it needs. A researcher
gets the project description and domain questions; it does not get the full
planning history. A verifier gets every plan and summary; it does not get the
raw research. Isolation keeps each agent's context dense with signal rather
than diluted by noise from other pipeline stages.

**Context hygiene across sessions.** Because all state lives in
`.planning/` as human-readable Markdown and JSON (not in any agent's context
window), GSD workflows survive context resets (`/clear`), tab switches, and
multi-day breaks. The next agent always starts from persisted, verified
artifacts rather than from a reconstructed memory of a long conversation.

---

## Trade-offs

Multi-agent orchestration is not free.

**Coordination overhead.** Each agent spawn is a round-trip: the orchestrator
must format a prompt, hand off context, wait for the subagent to complete
(typically 1–5 minutes), and then parse the result. A single capable agent
working in one context would finish faster for simple tasks. GSD mitigates
this by making parallelism the default wherever dependencies permit — the
four researchers in a `plan-phase` run simultaneously, not sequentially.

**Opacity during execution.** While a subagent is running, its work is
invisible to the parent session. There is no live progress stream. This is a
deliberate consequence of the fresh-context design: the subagent is operating
in its own context window. The orchestrator shows a liveness note on the
spawn line ("runs in a subagent — no output until it returns") to set
expectations.

**Context stitching cost.** Packaging the right artifacts for each agent
requires the orchestrator to spend tokens assembling and transmitting context
payloads. This is the cost of isolation. The `gsd-tools.cjs init` handler
produces a JSON payload that balances completeness with token budget, applying
cache-friendly ordering so that the stable parts of the payload (project
definition, config) hit the cache on repeat invocations.

**Model cost amplification.** Running five agents in parallel at Opus tier
costs more than running one. The model profile system (`model_profiles.md`,
resolved per agent by `model-profiles.cjs`) lets you assign cheaper tiers to
less critical agents. The `dynamic_routing` feature further reduces cost by
starting every agent on a cheaper tier and escalating only on a soft failure.
See [Configuration](../CONFIGURATION.md) for the full options.

In return for these costs, the design buys *consistent quality across large
phases*. An executor writing the tenth file in a 400-line plan does not
degrade because its context is fresh. A verifier checking twenty requirements
does not forget the first ten because it received all of them as structured
input rather than conversation history.

---

## Related

- [Context engineering](context-engineering.md) — the upstream principle that
  motivates this design
- [Configure model profiles](../how-to/configure-model-profiles.md) — how to
  assign model tiers per agent
- [Configuration reference](../CONFIGURATION.md) — full `config.json` schema
  including `models`, `model_overrides`, `dynamic_routing`, and
  `context_window`
- [Inventory](../INVENTORY.md) — authoritative agent roster and workflow list
- [Architecture](../ARCHITECTURE.md#agent-model) — implementation-level detail
  on the orchestrator → agent pattern and wave execution model
- [Docs index](../README.md)
