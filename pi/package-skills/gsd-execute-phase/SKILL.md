---
name: gsd-execute-phase
description: "SDD phase execution — execute all plans in a phase with dependency-aware wave parallelization"
---
Invoke this Pi skill with `/skill:gsd-execute-phase`.

**Pi host constraint (fail closed).** Pi has no subagent dispatch API. Any workflow step that spawns, delegates or dispatches a subagent — an `Agent(...)` or Task call, a `subagent_type`, "subagent spawns", or any named `gsd-*` role — cannot run here. When you reach one, STOP that step: tell the user which role it needs and that Pi cannot dispatch it yet (tracked in https://github.com/open-gsd/gsd-core/issues/5559). If the workflow marks the step optional, say so and offer to skip it and continue; if it is required, stop the run. Never execute the role's work inline as a substitute.

**Pi includes.** Pi does not expand `@path` references in a skill. Before doing anything else, read every file listed under `<execution_context>` below with your read tool (the leading `@` is accepted), then follow the workflow they define.



<arguments>(the text typed after the skill name)</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

<objective>
Execute all plans in a phase using wave-based parallel execution.

Orchestrator stays lean: discover plans, analyze dependencies, group into waves, spawn subagents, collect results. Each subagent loads the full execute-plan context and handles its own plan.

Optional wave filter:
- `--wave N` executes only Wave `N` for pacing, quota management, or staged rollout
- phase verification/completion still only happens when no incomplete plans remain after the selected wave finishes

Flag handling rule:
- The optional flags documented below are available behaviors, not implied active behaviors
- A flag is active only when its literal token appears in the `<arguments>` block
- If a documented flag is absent from the `<arguments>` block, treat it as inactive

Context budget: ~15% orchestrator, 100% fresh per subagent.
</objective>

<execution_context>
@__GSD_PI_ENGINE_ROOT__/gsd-core/workflows/execute-phase.md
@__GSD_PI_ENGINE_ROOT__/gsd-core/references/ui-brand.md
</execution_context>



<context>
Phase: the `<arguments>` block

**Available optional flags (documentation only — not automatically active):**
- `--wave N` — Execute only Wave `N` in the phase. Use when you want to pace execution or stay inside usage limits.
- `--gaps-only` — Execute only gap closure plans (plans with `gap_closure: true` in frontmatter). Use after verify-work creates fix plans.
- `--interactive` — Execute plans sequentially inline (no subagents) with user checkpoints between tasks. Lower token usage, pair-programming style. Best for small phases, bug fixes, and verification gaps.

**Active flags must be derived from the `<arguments>` block:**
- `--wave N` is active only if the literal `--wave` token is present in the `<arguments>` block
- `--gaps-only` is active only if the literal `--gaps-only` token is present in the `<arguments>` block
- `--interactive` is active only if the literal `--interactive` token is present in the `<arguments>` block
- If none of these tokens appear, run the standard full-phase execution flow with no flag-specific filtering
- Do not infer that a flag is active just because it is documented in this prompt

Context files are resolved inside the workflow via `gsd-tools query init.execute-phase` and per-subagent `<required_reading>` blocks.
</context>

<process>
Execute end-to-end.
Preserve all workflow gates (wave execution, checkpoint handling, verification, state updates, routing).
</process>
