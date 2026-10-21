---
name: gsd-add-tests
description: "Generate tests for a completed phase based on UAT criteria and implementation"
---
Invoke this Pi skill with `/skill:gsd-add-tests`.

**Pi host constraint (fail closed).** Pi has no subagent dispatch API. Any workflow step that spawns, delegates or dispatches a subagent — an `Agent(...)` or Task call, a `subagent_type`, "subagent spawns", or any named `gsd-*` role — cannot run here. When you reach one, STOP that step: tell the user which role it needs and that Pi cannot dispatch it yet (tracked in https://github.com/open-gsd/gsd-core/issues/5559). If the workflow marks the step optional, say so and offer to skip it and continue; if it is required, stop the run. Never execute the role's work inline as a substitute.

**Pi includes.** Pi does not expand `@path` references in a skill. Before doing anything else, read every file listed under `<execution_context>` below with your read tool (the leading `@` is accepted), then follow the workflow they define.



<arguments>(the text typed after the skill name)</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

<objective>
Generate unit and E2E tests for a completed phase, using its SUMMARY.md, CONTEXT.md, and VERIFICATION.md as specifications.

Analyzes implementation files, classifies them into TDD (unit), E2E (browser), or Skip categories, presents a test plan for user approval, then generates tests following RED-GREEN conventions.

Output: Test files committed with message `test(phase-{N}): add unit and E2E tests from add-tests command`
</objective>

<execution_context>
@__GSD_PI_ENGINE_ROOT__/gsd-core/workflows/add-tests.md
</execution_context>

<context>
Phase: the `<arguments>` block

@.planning/STATE.md
@.planning/ROADMAP.md
</context>

<process>
Execute end-to-end.
Preserve all workflow gates (classification approval, test plan approval, RED-GREEN verification, gap reporting).
</process>
