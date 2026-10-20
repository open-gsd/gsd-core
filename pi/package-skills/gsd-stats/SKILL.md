---
name: gsd-stats
description: "Display project statistics — phases, plans, requirements, git metrics, and timeline"
---
Invoke this Pi skill with `/skill:gsd-stats`.

**Pi host constraint (fail closed).** Pi has no subagent dispatch API. Any workflow step that spawns, delegates or dispatches a subagent — an `Agent(...)` or Task call, a `subagent_type`, "subagent spawns", or any named `gsd-*` role — cannot run here. When you reach one, STOP that step: tell the user which role it needs and that Pi cannot dispatch it yet (tracked in https://github.com/open-gsd/gsd-core/issues/5559). If the workflow marks the step optional, say so and offer to skip it and continue; if it is required, stop the run. Never execute the role's work inline as a substitute.

**Pi includes.** Pi does not expand `@path` references in a skill. Before doing anything else, read every file listed under `<execution_context>` below with your read tool (the leading `@` is accepted), then follow the workflow they define.


<objective>
Display comprehensive project statistics including phase progress, plan execution metrics, requirements completion, git history stats, and project timeline.
</objective>

<execution_context>
@__GSD_PI_ENGINE_ROOT__/gsd-core/workflows/stats.md
</execution_context>

<process>
Execute end-to-end.
</process>
