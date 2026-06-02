# The phase loop

> The central mental model for how GSD Core organises work.

---

## What the loop is

GSD Core structures all development work as a repeating cycle:

```text
Discuss → (UI design) → Plan → Execute → Verify → Ship
```

Every unit of work — called a **phase** — moves through these steps in order. The loop is not a formality. Each step exists because it guards against a specific class of failure that the previous step alone cannot prevent.

This document explains *why* the loop is shaped the way it is. For instructions on running each step, see the how-to guides linked at the bottom.

---

## Why each step exists

### Discuss

Planning cannot begin until you know *how* to build the thing, not just *what* to build. The phase goal in `ROADMAP.md` describes the outcome. The Discuss step captures the implementation decisions that shape the path to that outcome: which libraries, which error-handling strategy, whether a feature is per-route or global, how edge cases should behave.

Without a Discuss step, the planner must make these calls itself. Sometimes it guesses right. Often it guesses plausibly but wrongly — producing a plan that is coherent but misaligned with your actual preferences. By the time execution is done and you realise the error, you are unwinding significant work.

The Discuss step is deliberately lightweight. It is a conversation, not a specification exercise. The output is a `CONTEXT.md` in the phase directory: a structured record of decisions that the planner, executor, and verifier can all read. The conversation takes a few minutes; it can save hours of rework.

### UI design (optional)

For phases with a visual component, there is an optional `/gsd-ui-phase` step between Discuss and Plan. It produces a `UI-SPEC.md` — a design contract that describes layout, interaction, and visual behaviour before any code is written. This step is worth running when the UI is complex enough that ambiguity in the design would produce divergent implementation choices. A clear design contract is far cheaper to write than to re-implement.

### Plan

The Plan step does the research, decomposition, and structural thinking that execution requires. It runs as a sequence of fresh-context subagents: a researcher that investigates the ecosystem and records findings in `RESEARCH.md`, a planner that reads both the research and the `CONTEXT.md` to produce `PLAN.md` files, and a plan-checker that verifies the plans are complete, consistent, and within scope.

What does a plan contain? Each `PLAN.md` describes a bounded unit of work: the files to touch, the specific changes to make, the acceptance criteria that define done. Plans are ordered into dependency waves so that parallel execution is safe — executors in the same wave touch non-overlapping concerns.

The Plan step is the moment when ambiguity is most expensive. An ambiguous plan produces an executor that makes assumptions. Multiple parallel executors making different assumptions about the same concern produce conflicts. The plan-checker's job is to catch these before execution begins, not after.

### Execute

Execution runs the plans. Each executor gets a fresh 200k-token context window loaded with exactly what it needs: the project summary, the phase context, the research, and the specific `PLAN.md` for its task. Nothing more.

Executors write code and commit atomically. Each commit corresponds to a completed task in a plan. When a wave of parallel executors finishes, the orchestrator merges their state and starts the next wave.

The executor's fresh context is not a convenience — it is the mechanism by which context rot is prevented. An executor that runs with 180k tokens of accumulated session history is a degraded executor. An executor that starts clean and reads only what its plan requires is an executor operating at full capacity.

### Verify

After all executors have completed, a verifier agent reads the phase goal, the `CONTEXT.md` decisions, the plans, and the execution summaries — and checks that what was built matches what was intended. It produces a `VERIFICATION.md` and, if there are discrepancies, generates targeted fix plans.

Verification is not just testing. It checks requirement coverage (were all the REQ-IDs addressed?), decision coverage (were the decisions captured in `CONTEXT.md` actually implemented?), and overall phase goal alignment. A phase is not done because execution finished without errors. It is done because what was built is what was planned, and what was planned is what was decided.

### Ship

The Ship step creates the pull request and archives the phase artefacts. `STATE.md` is updated to mark the phase complete. The loop then begins again for the next phase.

---

## Milestones and phases

A **milestone** is a version cycle — a meaningful, releasable increment of the project. It has a name, a version number, and a set of requirements that define what it must deliver. A milestone is complete when all its phases are shipped and its requirements are covered.

A **phase** is one unit of work within a milestone. A phase has a goal, a set of requirements it addresses, and a set of plans that implement it.

The relationship matters because milestones and phases have different scopes of concern. A milestone asks: "What does this version of the product do, and what does it not do?" A phase asks: "What is the next bounded thing we can research, plan, execute, and verify?"

Milestone boundaries are drawn at natural product boundaries — a deployable API, a working UI flow, a complete data model. Phase boundaries are drawn at the limits of what can be safely executed in one loop without the loop becoming unwieldy.

---

## What makes a good phase scope

This is worth dwelling on because it is the most common source of friction with the loop.

A phase that is too large becomes a research project unto itself. The planner struggles to decompose it into independent plans. Executors in later waves are blocked waiting for earlier waves. Verification becomes a full audit rather than a targeted review. The feedback cycle stretches from hours to days, and the risk of discovering a fundamental design mistake late — after much code has been written — rises sharply.

A phase that is too small fragments work that naturally belongs together. You end up with plan files that are half a dozen lines, phases that complete in minutes, and a planning overhead that dwarfs the execution cost. The loop feels bureaucratic rather than helpful.

A good phase scope is one where:

- The goal can be stated in a single sentence that is neither obviously trivial nor suspiciously broad.
- The research needed to plan it is bounded — the ecosystem questions have answers that do not depend on other phases completing first.
- The execution can be parallelised into a handful of non-overlapping plans, not dozens.
- There is a clear, testable definition of done that a verifier can check without reading the entire codebase.

Concretely: "Add HMAC-SHA256 signature validation middleware" is a good phase scope. "Build the authentication system" usually is not — it almost always contains multiple independent concerns that would be better as separate phases. "Fix the typo in the README" is below the threshold where the loop adds value; use `/gsd-quick` instead.

When in doubt, split. A smaller phase completes faster, verifies more confidently, and makes it easier to course-correct if a design decision turns out to be wrong.

---

## How `.planning/` carries state across the loop

The loop is not a single session. Research, planning, and execution may happen across multiple sessions, with context resets in between. The `.planning/` directory is what makes this possible.

Every step of the loop reads artefacts produced by earlier steps and writes artefacts for later steps. The CONTEXT.md that the Discuss step produces is still available when the Planner runs — even if that is in a different session hours later. The PLAN.md files that the Planner produces are still available when the Executor runs — even across a restart. The VERIFICATION.md that the Verifier writes is still available when you review the phase.

`STATE.md` is the navigation layer above all of this. It records exactly where in the loop the project currently sits: which milestone is active, which phase is in progress, which plans are complete and which are pending. Any agent or workflow that needs to orient itself reads `STATE.md` first.

For the precise structure of these files, see [Planning artifacts](../reference/planning-artifacts.md) and the [STATE.md schema](../reference/state-md.md).

---

## The loop is a rhythm, not a constraint

It is tempting to see the loop as bureaucracy — a set of required steps that you have to perform before you are allowed to write code. That framing is wrong.

The loop exists because each step prevents failures that are genuinely expensive to fix later. Discuss prevents planning on wrong assumptions. Plan prevents executing a design that is fundamentally broken. Verify prevents shipping work that missed the brief. These are not invented problems. They are the actual failure modes of AI-assisted development at the scale of real features.

When the loop works well, it feels like a rhythm: a cadence of focused, bounded work where each step is clear because the previous step did its job. The overhead is real, but it is front-loaded — paid in minutes of planning rather than hours of rework.

For work that falls below the threshold where the loop is warranted, GSD Core provides lighter primitives. The phase loop is one tool, not the only tool.

---

## Related

- [Context engineering](context-engineering.md) — why fresh-context subagents prevent the quality degradation that makes the loop necessary
- [Discuss a phase](../how-to/discuss-a-phase.md)
- [Plan a phase](../how-to/plan-a-phase.md)
- [Execute a phase](../how-to/execute-a-phase.md)
- [Verify and ship](../how-to/verify-and-ship.md)
- [Planning artifacts](../reference/planning-artifacts.md)
- [STATE.md schema](../reference/state-md.md)
- [docs index](../README.md)
