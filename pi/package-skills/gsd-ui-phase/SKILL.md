---
name: gsd-ui-phase
description: "Generate UI design contract (UI-SPEC.md) for frontend phases"
---
Invoke this Pi skill with `/skill:gsd-ui-phase`.

**Pi host constraint (fail closed).** Pi has no subagent dispatch API. Any workflow step that spawns, delegates or dispatches a subagent — an `Agent(...)` or Task call, a `subagent_type`, "subagent spawns", or any named `gsd-*` role — cannot run here. When you reach one, STOP that step: tell the user which role it needs and that Pi cannot dispatch it yet (tracked in https://github.com/open-gsd/gsd-core/issues/5559). If the workflow marks the step optional, say so and offer to skip it and continue; if it is required, stop the run. Never execute the role's work inline as a substitute.

**Pi includes.** Pi does not expand `@path` references in a skill. Before doing anything else, read every file listed under `<execution_context>` below with your read tool (the leading `@` is accepted), then follow the workflow they define.



<arguments>(the text typed after the skill name)</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

<objective>
Create a UI design contract (UI-SPEC.md) for a frontend phase.
Orchestrates gsd-ui-researcher and gsd-ui-checker.
Flow: Validate → Research UI → Verify UI-SPEC → Done
</objective>

<execution_context>
@__GSD_PI_ENGINE_ROOT__/gsd-core/workflows/ui-phase.md
@__GSD_PI_ENGINE_ROOT__/gsd-core/references/ui-brand.md
</execution_context>

<context>
Phase number: the `<arguments>` block — optional, auto-detects next unplanned phase if omitted.
</context>

<process>
Execute end-to-end.
Preserve all workflow gates.
</process>
