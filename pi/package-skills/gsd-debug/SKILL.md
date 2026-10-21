---
name: gsd-debug
description: "Systematic debugging with persistent state across context resets"
---
Invoke this Pi skill with `/skill:gsd-debug`.

**Pi host constraint (fail closed).** Pi has no subagent dispatch API. Any workflow step that spawns, delegates or dispatches a subagent — an `Agent(...)` or Task call, a `subagent_type`, "subagent spawns", or any named `gsd-*` role — cannot run here. When you reach one, STOP that step: tell the user which role it needs and that Pi cannot dispatch it yet (tracked in https://github.com/open-gsd/gsd-core/issues/5559). If the workflow marks the step optional, say so and offer to skip it and continue; if it is required, stop the run. Never execute the role's work inline as a substitute.

**Pi includes.** Pi does not expand `@path` references in a skill. Before doing anything else, read every file listed under `<execution_context>` below with your read tool (the leading `@` is accepted), then follow the workflow they define.



<arguments>(the text typed after the skill name)</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

<objective>
Debug issues using scientific method with subagent isolation.

**Orchestrator role:** Gather symptoms, spawn gsd-debugger agent, handle checkpoints, spawn continuations.

**Flags:**
- `--diagnose` — Diagnose only. Returns a Root Cause Report without applying a fix.

**Subcommands:** `list` · `status <slug>` · `continue <slug>`
</objective>

<available_agent_types>
Valid GSD subagent types (use exact names — do not fall back to 'general-purpose'):
- gsd-debug-session-manager — manages debug checkpoint/continuation loop in isolated context
- gsd-debugger — investigates bugs using scientific method
</available_agent_types>

<execution_context>
@__GSD_PI_ENGINE_ROOT__/gsd-core/workflows/debug.md
</execution_context>

<context>
User's input: the `<arguments>` block

Parse subcommands and flags from the `<arguments>` block BEFORE the active-session check:
- If the `<arguments>` block starts with "list": SUBCMD=list, no further args
- If the `<arguments>` block starts with "status ": SUBCMD=status, SLUG=remainder (trim whitespace)
- If the `<arguments>` block starts with "continue ": SUBCMD=continue, SLUG=remainder (trim whitespace)
- If the `<arguments>` block contains `--diagnose`: SUBCMD=debug, diagnose_only=true, strip `--diagnose` from description
- Otherwise: SUBCMD=debug, diagnose_only=false

Check for active sessions (used for non-list/status/continue flows):
```bash
ls .planning/debug/*.md 2>/dev/null | grep -v '/knowledge-base\.md$' | head -5
```
</context>

<process>
Execute end-to-end.
</process>
