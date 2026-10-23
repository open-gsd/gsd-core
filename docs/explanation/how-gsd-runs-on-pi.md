# How GSD runs on Pi

[Pi](https://pi.dev) has skills, extensions and tools, but no subagent primitive and no statusline. GSD maps its own model onto what Pi has. This page explains the mapping and the limits it leaves; the exact per-surface result is in the [Pi parity matrix](../reference/pi-parity-matrix.md).

## Commands become skills

A GSD command is a Markdown file that points at a workflow. Pi loads `SKILL.md` directories and runs them as `/skill:<name>`, so the installer converts each command into a Pi skill named `gsd-<command>`. Pi does not expand `@path` includes inside a skill, so each skill opens by telling the model to read the workflow files it lists. `/gsd <command>` hands off to the same skill; `/gsd <family> <subcommand>` and the `gsd_invoke` tool stay the scripted data surface that returns tool output.

## Roles become `gsd_dispatch` calls

Claude Code starts a named agent with its `Agent` tool. Pi has nothing like it, so the installer rewrites the workflow text: each `Agent(...)` step becomes `gsd_dispatch(role=..., task=...)`. The tool, added by the GSD extension, resolves the role from the installed role files, checks the role bytes against the install manifest, and runs it in a separate `pi` process with its own context. The child gets no extensions and no dispatch tool, so dispatch is one level deep and calls run one at a time. A refusal is an error result with a stable code, never a silent fallback to doing the step inline. The reasoning is recorded in [ADR-5559](../adr/5559-pi-agent-role-dispatch.md).

## Guards become event handlers

Claude Code runs hook scripts on tool events. The GSD extension listens for the Pi events that match (`tool_call`, `tool_result`, `session_start`, `before_agent_start`, `session_before_compact`) and runs the same hook scripts as subprocesses, translating Pi's tool names and inputs to the shape the scripts read. A hook that needs something Pi lacks, such as the statusline metrics, is recorded as unsupported with its reason. See [Pi hook and lifecycle parity](../reference/pi-hook-parity.md).

## What this costs

- A role cannot start another role, so `/gsd-debug`, whose session manager starts a debugger, is installed as a stub that says so.
- A dispatched role cannot take a per-call model or run in the background.
- A guard Pi has no event for does not run.

Each limit is listed with its reason in the parity matrix, and `tests/pi-parity-matrix.test.cjs` fails when a Claude surface is added without a Pi disposition, so the list cannot drift silently.
