---
name: gsd-review
description: "Request cross-AI peer review of phase plans from external AI CLIs"
---
Invoke this Pi skill with `/skill:gsd-review`.

**Pi dispatch (fail closed).** Pi has no built-in subagent API; GSD provides the `gsd_dispatch` tool. Where a workflow step dispatches a named `gsd-*` role, call `gsd_dispatch` with `role` (the installed role name) and `task` (the full task text). A workflow that still writes the step as an `Agent(...)` call means the same: its `subagent_type` is the `role` and its `prompt` is the `task`. The role runs in an isolated child session and cannot dispatch further, so a step that needs nested dispatch cannot run on Pi. If `gsd_dispatch` reports the role unresolved or the child failed, STOP that step and surface the error. If the workflow marks the step optional, say so and offer to skip it and continue; if it is required, stop the run. Never execute the role's work inline as a substitute.

**Pi includes.** Pi does not expand `@path` references in a skill. Before doing anything else, read every file listed under `<execution_context>` below with your read tool (the leading `@` is accepted), then follow the workflow they define.



<arguments>(the text typed after the skill name)</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

<objective>
Invoke external AI CLIs (Claude, Codex, OpenCode, Qwen Code, Cursor, Antigravity) to independently review phase plans.
Produces a structured REVIEWS.md with per-reviewer feedback that can be fed back into
planning via /skill:gsd-plan-phase --reviews.

**Flow:** Detect CLIs → Build review prompt → Invoke each CLI → Collect responses → Write REVIEWS.md
</objective>

<execution_context>
@__GSD_PI_ENGINE_ROOT__/gsd-core/workflows/review.md
</execution_context>

<context>
Phase number: extracted from the `<arguments>` block (required)

**Flags:**
- `--claude` — Include Claude CLI review (uses separate session)
- `--codex` — Include Codex CLI review
- `--opencode` — Include OpenCode review (uses model from user's OpenCode config)
- `--qwen` — Include Qwen Code review (Alibaba Qwen models)
- `--cursor` — Include Cursor agent review
- `--agy` / `--antigravity` — Include Antigravity CLI review
- `--all` — Include all available CLIs

**No flags** — if `review.default_reviewers` is set, review with only those configured
reviewers that are detected; otherwise review with all available CLIs. Configured
`review.reviewer_instances` names may appear in `review.default_reviewers`; each runs as an
independent reviewer identity backed by its configured adapter+model (see
`docs/CONFIGURATION.md`). Instance names are not valid as flags.
</context>

<process>
Execute end-to-end.
</process>
