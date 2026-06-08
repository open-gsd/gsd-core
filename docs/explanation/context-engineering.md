# Context engineering

> Why GSD Core exists, and the problem it is designed to solve.

---

## The problem: context rot

Every AI coding session starts fresh. The model reads your question, reasons over it, and replies. But a session is rarely one exchange. You ask follow-up questions, paste error messages, iterate on code, redirect the model when it drifts. Each turn adds tokens to the context window — the finite buffer of text the model can "see" at once.

As that window fills, something subtle happens. The model does not fail loudly. It keeps answering. But the quality of its answers quietly degrades. Early instructions get pushed towards the edge of what it can attend to. Nuance from the first few exchanges — the constraints you stated, the architecture you agreed on, the edge cases you flagged — competes for attention against everything that came later. Researchers call this **context rot**.

Context rot manifests in several ways:

- The model starts contradicting earlier decisions it acknowledged.
- Code style drifts away from the conventions established at session start.
- Plans begin to ignore requirements that were clearly stated but are now buried deep in the history.
- The model hallucinates file names or function signatures it had correct twenty messages ago.

None of this is a model bug. It is a fundamental property of how transformer attention works over long sequences. The model is not forgetting — it never "remembered" in the human sense. It is weighting relevance across a finite window, and as that window fills with accumulated noise, signal-to-noise degrades.

The naive response is to `/clear` and start over. But that loses continuity. You have to re-explain context, re-paste relevant files, re-state constraints. The session essentially resets to zero.

---

## GSD Core's answer: fresh-context subagents

GSD Core's central insight is that *most* of the work in a coding session does not need to happen in the main context at all. Research, planning, code writing, and verification are each discrete, bounded tasks. Each can be handed to a specialised subagent that starts with a clean, carefully scoped context window — and reports its result back to a thin orchestrator that stays lean.

This is not a workaround for context rot. It is a structural solution.

The orchestrator — your main session — never touches source files. It spawns agents, collects their results, updates shared state, and routes to the next step. Because it does very little itself, its context window grows slowly and predictably. The heavy work happens in agents that each start fresh, receive exactly the context they need for their task, and terminate when done.

Consider what this means in practice. When you run `/gsd-plan-phase`, the orchestrator:

1. Loads a compact JSON context payload (project summary, phase goal, relevant config).
2. Spawns a researcher agent with a 200k-token clean window.
3. Spawns a planner agent with the research output and phase requirements.
4. Spawns a plan-checker agent to verify the plan before execution.

Each agent operates at full capacity, unencumbered by the accumulated history of your session. When the planner writes its `PLAN.md` files to `.planning/phases/`, that output becomes a durable artefact — not a fragile memory in a shared context window.

---

## Spec-driven development and meta-prompting

Context engineering alone is not enough. If an agent starts fresh but receives vague instructions, it will produce vague output. GSD Core pairs fresh-context subagents with two complementary disciplines:

**Spec-driven development** means that every phase produces structured artefacts before execution begins. A `CONTEXT.md` captures implementation decisions from the Discuss step. A `RESEARCH.md` records what the researcher found. A `PLAN.md` breaks work into discrete, dependency-ordered tasks with explicit acceptance criteria. By the time an executor agent touches a file, it has a precise specification to work from — not a re-interpretation of a long conversation.

**Meta-prompting** means the agent definitions themselves are carefully engineered prompts, not ad-hoc instructions. The files in `gsd-core/workflows/` and `agents/` encode hard-won knowledge about how to scope tasks, what to verify, and when to escalate to a human checkpoint. The user does not need to re-explain this knowledge in every session; it is baked into the system's own prompts.

The combination is deliberate. Fresh context ensures each agent reasons clearly. Spec-driven artefacts ensure each agent reasons about the *right* thing. Meta-prompting ensures each agent knows *how* to reason about it well.

---

## The role of `.planning/`

Context engineering requires that knowledge survive context resets. GSD Core uses the file system for this. Every meaningful output is written to `.planning/` as human-readable Markdown or JSON. This means:

- Restarting your session (or the model crashing) does not lose work.
- Any subsequent agent can read prior artefacts directly, without depending on a shared conversation history.
- You can inspect, edit, or commit planning artefacts to git — they are plain text, not opaque state in a database.

`STATE.md` is the spine of this system. It records the project's current position (which milestone, which phase, which plans are complete), active decisions and blockers, and progress metrics. When any workflow starts, it reads `STATE.md` to orient itself. When any workflow finishes a meaningful step, it writes back to `STATE.md`. Agents do not rely on memory; they rely on the file.

---

## Lifecycle hooks and context headroom

The fresh-context subagent model protects each spawned agent from accumulating noise. But there is a subtler problem: the *orchestrating session itself* fills up over time. A long-running orchestration silently consumes its own context window — loading payloads, reading status output, routing between phases. Without any signal about how much headroom remains, the session can quietly degrade or, worse, trigger an automatic compaction that silently discards planning state the orchestrator was relying on.

Since GSD 1.4.0, this is addressed by registering runtime lifecycle hooks. Rather than leaving headroom invisible, these hooks give GSD a per-turn signal — a moment to inspect how much context has been consumed and emit a warning before the window is exhausted. The hooks run inside the runtime itself, so the measurement is as close to authoritative as possible: GSD is not guessing from the outside.

### One idea, many runtime vocabularies

Each AI runtime exposes lifecycle events in its own vocabulary, but the purpose is the same across all of them: fire at boundaries that correspond to context pressure or turn transitions, so GSD can observe and react.

- **Claude Code** fires `PreCompact` when a compaction is about to occur, `Stop` when a session turn ends, and `SubagentStop` when a spawned subagent completes. Together these bracket the moments when context has grown or a context-consuming task has just finished.
- **Gemini** fires `BeforeAgent`/`AfterAgent` around each agent invocation, and `BeforeModel` before each model call — giving a per-inference opportunity to check headroom.
- **Qwen** exposes `SubagentStop`, `Stop`, and `PreCompact`, mirroring Claude Code's shape in its own event system.

Think of these as the same concept — "notify GSD at context boundaries" — expressed in each runtime's native event vocabulary. This is the multi-runtime philosophy applied at the observability layer: GSD registers the semantically equivalent hook wherever each runtime exposes it, rather than demanding every runtime adopt a single event schema.

For the per-runtime event matrix, see [FEATURES.md](../FEATURES.md) under Multi-Runtime Support. For how to enable hooks on your specific runtime, see [Install on your runtime](../how-to/install-on-your-runtime.md).

### Config hot-reload via `FileChanged`

Claude Code exposes a `FileChanged` event in addition to session-lifecycle hooks. Claude Code's `FileChanged` hook watches for changes to `config.json` and hot-reloads the project's `.planning/config.json` into the session. The practical reason is straightforward: configuration changes should take effect without forcing the user to clear and rebuild the session.

Requiring a `/clear` to pick up a config edit would destroy the very continuity the context-engineering design is trying to protect. By watching for `FileChanged` on `config.json`, GSD can reload configuration mid-session — adjusting model profiles, context-window thresholds, or routing preferences — without the user losing their place. The working context survives; the configuration updates beneath it.

### Forked context for heavy skills

Beyond passive monitoring, GSD uses an active strategy for skills whose work is large and bursty: they run in a **forked context** (`context: fork` in the skill definition).

Skills like `plan-phase`, `execute-phase`, and `autonomous` do a great deal of work — spawning multiple subagents, reading large files, iterating over multiple plans. If that work happened in the main session, it would consume a substantial share of the orchestrator's context budget. The forked context prevents this: the skill runs in an isolated context of its own, does its heavy lifting there, and the main session's headroom is preserved.

This is the same context-engineering principle as the fresh-context subagent model — applied not at the session boundary, but at the skill-invocation boundary. The difference is one of granularity. The phase loop spawns fresh subagents to protect each agent from its siblings' noise. Forked context protects the orchestrating session from the skill's own accumulated noise while the skill runs.

Complementing this, quick-status skills explicitly declare low effort in their definitions. This is a budget-conscious signal in the opposite direction: these skills read minimal state and return concise output, keeping their own footprint small by design.

### Trade-offs

This machinery is worth being honest about.

**Hooks add maintenance surface.** Every runtime GSD supports must have its hooks registered, tested, and kept in sync with that runtime's event API. When a runtime changes its event names or firing semantics, GSD's hook registration needs updating. This is the cost of per-runtime observability rather than a single shared mechanism.

**Headroom tracking is a heuristic.** The hooks give GSD a signal, not a guarantee. A single model call can consume tokens unpredictably depending on the response length, tool use, and caching behaviour. GSD uses headroom estimates to warn and steer, not to make hard guarantees about what will fit.

**Forked context is isolated.** The forked work cannot see uncommitted state in the main session. This is not a bug — it is necessary for isolation — but it means anything the forked skill needs to know must be on disk before the fork occurs. This is precisely why `.planning/` exists as the shared substrate: plan files, `STATE.md`, `CONTEXT.md`, and `config.json` are all durable, file-system artefacts that any context — main or forked — can read. The context-engineering design is self-consistent: the same principle that makes fresh-context subagents work (shared state lives in files, not in a conversation) is what makes forked context viable. See also [Multi-agent orchestration](multi-agent-orchestration.md) for how `.planning/` serves the same role across the orchestrator → agent boundary.

---

## Trade-offs

Honesty about trade-offs matters here.

**Overhead.** The phase loop introduces real friction. Running `/gsd-discuss-phase`, `/gsd-plan-phase`, and `/gsd-execute-phase` as separate steps takes more elapsed time than typing "write this feature" into a plain session. For a small, well-understood change, that overhead is not justified.

**Latency.** Spawning multiple subagents with fresh context is slower than a single in-context edit. Research, planning, and execution each incur round-trip costs.

**Ceremony for simple tasks.** If you need to rename a variable, fix a typo, or add a missing import, the phase loop is overkill. GSD Core provides `/gsd-quick` and `/gsd-fast` for ad-hoc work that does not warrant a full phase. See [Handle quick and fast tasks](../how-to/handle-quick-and-fast-tasks.md).

The phase loop pays for itself when the work is complex enough that context rot is a real risk — multi-file features, cross-cutting refactors, work that spans hours or sessions. For everything else, reach for the lighter primitive.

A useful rule of thumb: if the task could be fully specified in a single, short prompt and completed in one agent turn without further clarification, skip the phase loop. If the task requires research, involves files you have not read recently, or depends on decisions that are not yet settled, the phase loop protects you.

---

## Related

- [The phase loop](the-phase-loop.md) — how the Discuss → Plan → Execute → Verify → Ship cycle puts context engineering into practice
- [Multi-agent orchestration](multi-agent-orchestration.md) — how subagents are spawned, scoped, and coordinated
- [Architecture](../ARCHITECTURE.md) — system architecture, agent model, and data flow
- [docs index](../README.md)
