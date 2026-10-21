---
name: gsd-config
description: "Configure GSD settings — workflow toggles, advanced knobs, integrations, and model profile"
---
Invoke this Pi skill with `/skill:gsd-config`.

**Pi dispatch (fail closed).** Pi has no built-in subagent API; GSD provides the `gsd_dispatch` tool. Where a workflow step dispatches a named `gsd-*` role, call `gsd_dispatch` with `role` (the installed role name) and `task` (the full task text). A workflow that still writes the step as an `Agent(...)` call means the same: its `subagent_type` is the `role` and its `prompt` is the `task`. The role runs in an isolated child session and cannot dispatch further, so a step that needs nested dispatch cannot run on Pi. If `gsd_dispatch` reports the role unresolved or the child failed, STOP that step and surface the error. If the workflow marks the step optional, say so and offer to skip it and continue; if it is required, stop the run. Never execute the role's work inline as a substitute.

**Pi includes.** Pi does not expand `@path` references in a skill. Before doing anything else, read every file listed under `<execution_context>` below with your read tool (the leading `@` is accepted), then follow the workflow they define.



<arguments>(the text typed after the skill name)</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

<objective>
Configure GSD settings interactively with a single consolidated command.

Mode routing:
- **default** (no flag): Common-case toggles (model, research, plan_check, verifier, branching) → settings workflow
- **--advanced**: Power-user knobs (planning tuning, timeouts, branch templates, cross-AI execution) → settings-advanced workflow
- **--integrations**: Third-party API keys, code-review CLI routing, agent-skill injection → settings-integrations workflow
- **--profile <name>**: Switch model profile (quality|balanced|budget|inherit) → set-profile (inline)
</objective>

<routing>

| Flag | Action | Workflow |
|------|--------|----------|
| (none) | Interactive 5-question common-case config prompt | settings |
| --advanced | Power-user knobs: planning, execution, discussion, cross-AI, git, runtime | settings-advanced |
| --integrations | API keys (Brave/Firecrawl/Exa), review CLI routing, agent skills | settings-integrations |
| --profile &lt;name&gt; | Switch model profile without interactive prompt | gsd-tools query config-set-model-profile |

</routing>

<execution_context>
@__GSD_PI_ENGINE_ROOT__/gsd-core/workflows/settings.md
@__GSD_PI_ENGINE_ROOT__/gsd-core/workflows/settings-advanced.md
@__GSD_PI_ENGINE_ROOT__/gsd-core/workflows/settings-integrations.md
</execution_context>

<context>
Arguments: see the `<arguments>` block above.

Parse the first token of the `<arguments>` block:
- If it is `--advanced`: strip the flag, execute settings-advanced workflow
- If it is `--integrations`: strip the flag, execute settings-integrations workflow
- If it starts with `--profile`: extract the profile name (remainder after `--profile`), then:
  1. Verify `gsd-tools` is on PATH via `command -v gsd-tools`; if absent, emit the install hint `Install GSD via 'npm i -g @opengsd/gsd-core'` and stop.
  2. Run: `gsd-tools query config-set-model-profile <profile-name> --raw` and display the output verbatim.
- Otherwise: execute settings workflow (no argument needed)
</context>

<process>
1. Parse the leading flag (if any) from the `<arguments>` block.
2. Load and execute the appropriate workflow end-to-end, or run the inline SDK command for --profile.
3. Preserve all workflow gates from the target workflow.
</process>
