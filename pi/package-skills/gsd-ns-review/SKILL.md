---
name: gsd-ns-review
description: "quality gates | code review debug audit security eval ui"
---
Invoke this Pi skill with `/skill:gsd-ns-review`.

**Pi host constraint (fail closed).** Pi has no subagent dispatch API. Any workflow step that spawns, delegates or dispatches a subagent — an `Agent(...)` or Task call, a `subagent_type`, "subagent spawns", or any named `gsd-*` role — cannot run here. When you reach one, STOP that step: tell the user which role it needs and that Pi cannot dispatch it yet (tracked in https://github.com/open-gsd/gsd-core/issues/5559). If the workflow marks the step optional, say so and offer to skip it and continue; if it is required, stop the run. Never execute the role's work inline as a substitute.

**Pi includes.** Pi does not expand `@path` references in a skill. Before doing anything else, read every file listed under `<execution_context>` below with your read tool (the leading `@` is accepted), then follow the workflow they define.



<arguments>(the text typed after the skill name)</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

Route to the appropriate quality / review skill based on the user's intent.
`gsd-code-review-fix` was absorbed by `gsd-code-review --fix` in #2790.

| User wants | Invoke |
|---|---|
| Review code for quality and correctness | gsd-code-review |
| Auto-fix code review findings | gsd-code-review --fix |
| Audit UAT / acceptance testing | gsd-audit-uat |
| Security review of a phase | gsd-secure-phase |
| Evaluate AI response quality | gsd-eval-review |
| Review UI for design and accessibility | gsd-ui-review |
| Validate phase outputs | gsd-validate-phase |
| Debug a failing feature or error | gsd-debug |
| Forensic investigation of a broken system | gsd-forensics |
| Autonomous audit-to-fix pipeline | gsd-audit-fix |
| Cross-AI peer review of plans | gsd-review |
| Generate a UI design contract | gsd-ui-phase |

Invoke the matched skill directly using the Skill tool.
