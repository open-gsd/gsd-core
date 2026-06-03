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
