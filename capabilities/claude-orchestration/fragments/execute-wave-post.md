# Claude orchestration — Workflow execution backend (BETA)

> Injected at `execute:wave:post` `into: executor` only when
> `claude_orchestration.enabled` is true. Default-off; `onError: skip`.

## When this contribution is active

The Claude orchestration capability is **default-off and BETA**. It activates only
when ALL of the following hold:

1. `claude_orchestration.enabled` is `true` in `.planning/config.json`, AND
2. the active runtime is **Claude Code** (the Workflow tool is Claude / Agent
   SDK-specific), AND
3. `claude_orchestration.execution_backend` resolves to `workflow` — either
   explicitly, or via `auto` — **and** the Agent SDK version is
   `>= claude_orchestration.min_agent_sdk_version` (default `0.3.149`). The SDK
   floor applies in both `auto` and `workflow` modes (fail-closed: a pre-release
   or older SDK never activates the preview backend).

Detection is fail-closed: any miss degrades to **inline, manual, one-agent-per-
message dispatch** — exactly today's behaviour. On a non-Claude runtime this
contribution is a no-op.

## What the executor does when the Workflow backend is active

Instead of the orchestrator fanning out one `Agent(subagent_type=gsd-executor,
isolation=worktree, run_in_background=true)` per message (which on Claude Code
cannot nest further subagents — #853 — and so degrades to sequential inline
execution), execute-phase **emits a generated Workflow script** and lets the main
loop orchestrate it:

- **waves → one or more sequential `parallel()` barriers** — each wave is a
  barrier group; when plans within a wave share `files_modified`, they are split
  into separate sequential stages within that wave's barrier (the next wave
  still waits for the previous wave to complete).
- **plans → `agent(brief, { agentType: 'gsd-executor', isolation: 'worktree' })`**
  — the SAME executor agent and worktree isolation the inline path uses, so the
  produced `SUMMARY.md` and commits are identical.
- **`files_modified` overlap → separate sequential stages** — two plans that
  touch the same file are placed in different stages within the wave (the same
  overlap rule execute-phase already applies inline).
- **`resumeFromRunId`** — wired to the phase run id, so an interrupted phase
  resumes without re-running completed plans.
- **`budget(tokens)`** — a shared token pool across the whole phase when the
  orchestrator passes a `budgetTokens` value to `emitWorkflowScript` (it is a
  function parameter, not a config key; the orchestrator decides the budget).

The emitter is a pure function exposed through the capability command surface:
`gsd-tools claude-orchestration emit-workflow --waves <manifest.json> --run-id <id>
[--phase-dir <dir>] [--budget <n>]` (or `require('gsd-core/bin/lib/claude-orchestration.cjs').emitWorkflowScript`
directly). It maps the phase's wave/plan manifest to the Workflow script string
and never invokes the Workflow tool itself; the orchestrator runs the emitted
script. Detection is resolved by the orchestrator calling the pure
`detectWorkflowBackend` with the LIVE host descriptor (the CLI
`gsd-tools claude-orchestration detect-backend` is a simulation harness that
assumes a capable host unless `--no-nested-dispatch` is passed — it does not probe
the real runtime; the orchestrator supplies the real descriptor).

## Fallback contract

If detection resolves to `inline` (tool absent, SDK too old, runtime not Claude,
or the capability disabled), execute-phase MUST proceed with the standard inline
wave dispatch. The executor MUST NOT assume parallelism, a shared budget, or
resume-from-run-id semantics in that mode.
