# Claude orchestration capability (BETA)

> **Explanation** — *why this capability exists and how it fits the loop.* For the
> step-by-step, see the [capability reference](../reference/capability-matrix.md);
> for the design record, see [ADR-1143](../adr/1143-claude-orchestration-capability.md).

## The problem

GSD's `execute-phase` is wave-based: plans carry a wave number, waves run
sequentially, and plans *within* a wave run in parallel when their
`files_modified` sets don't overlap. On most runtimes GSD realizes that by
fanning out one backgrounded `gsd-executor` agent (in a worktree) per plan.

On **Claude Code** that fan-out degrades. Backgrounded agents on Claude Code have
no `Agent`/`Task` tool, so they cannot nest subagents ([#853]). The autonomous
loop therefore falls back to **inline sequential execution** — and with it
silently drops wave parallelism, the plan-checker, and the verifier — on the one
runtime most GSD users run.

Claude Code ships an orchestration primitive that sidesteps exactly this: the
**Workflow tool** (Claude Code's dynamic workflows, the engine behind `/effort ultracode`).
A Workflow script *is* the orchestrator — it runs from the main loop and spawns
subagents itself via `agent()`, `parallel()` (barrier), `pipeline()`, and
`phase()`, with `isolation: 'worktree'`. Two related capabilities are **tool
inputs rather than script functions**: the token `budget` is a read-only object
a script reads but cannot set, and `resumeFromRunId` is a parameter passed when
invoking the tool.

## The capability

`claude-orchestration` is a **default-off, BETA, claude-only** capability that
adopts the Workflow tool as an optional, runtime-gated parallel-execution
backend, and folds the existing `gsd-ultraplan-phase` plan-offload under the same
gate. It is blocked-on-nothing now that the ADR-857 capability system is released.

- **`role: feature`**, `runtimeCompat.supported: ["claude"]`, `tier: full`.
- **`activationKey: claude_orchestration.enabled`** — default `false`. Nothing
  changes until you opt in.
- Registers at one **wired** loop point: `plan:post` (into the planner),
  `onError: skip` and gated by the `enabled` key. The capability previously
  also contributed at `execute:wave:pre` (`into: executor`), but that fragment
  was pure orchestrator procedure — build a wave manifest, resolve the
  dispatch backend, spawn executor agents — with nothing an executor agent can
  act on. Injecting orchestrator instructions into executor prompts violates
  the loop's role partition (the orchestrator orchestrates, the executor
  executes), so the contribution was removed ([#4740]). The procedure text is
  preserved at
  [`capabilities/claude-orchestration/docs/workflow-backend-dispatch.md`](../../capabilities/claude-orchestration/docs/workflow-backend-dispatch.md)
  as reference for wiring the orchestrator side through a host-level
  mechanism; it is not injected anywhere.

## How it decides whether to activate

Detection is a pure, **fail-closed** function — `detectWorkflowBackend`. The
Workflow backend activates only when *every* gate passes; any miss degrades to
`inline` (today's behaviour):

1. `claude_orchestration.enabled` is true.
2. The runtime is Claude (the Workflow tool is Claude / Agent SDK-specific).
3. `claude_orchestration.execution_backend` is `auto` or `workflow` (not `inline`).
4. The host descriptor advertises `dispatch.nested` **and** `dispatch.background`
   (the nesting-capable Claude-Code shape — a proxy for Workflow-tool presence,
   meaningful only after gate 2).
5. No Claude Code workflow kill switch is set: `CLAUDE_CODE_DISABLE_WORKFLOWS`,
   or `disableWorkflows: true` / `enableWorkflows: false` in managed, project-local,
   project or user settings, resolved with Claude Code's own precedence. A settings
   file GSD cannot read counts as "on" — it cannot prove the switch is off.

Why kill switches and not a version number: Claude Code documents workflows as
available by plan (all paid plans, plus API, Bedrock, Google Cloud and Foundry
access) with a per-user toggle on Pro. Neither the plan nor the toggle is visible
to a tool outside Claude Code, and the version of the installed Agent SDK package
says nothing about either, so the earlier SDK-version floor was gating on the wrong
thing ([#4747]). What a tool *can* see is the documented way to turn workflows off,
so that is what detection reads. A session without workflow access can still pass
detection; the Workflow tool then refuses the run and dispatch falls back to inline.
The `claude_orchestration.min_agent_sdk_version` key is kept so old configs load,
and ignored.

## What the executor runs when the backend is active

`emitWorkflowScript` maps the phase's wave/plan model onto Workflow primitives:

| GSD concept | Workflow primitive |
|---|---|
| Wave | `parallel()` stage barrier |
| Plan (`use_worktree` not `false`) | `agent(brief, { agentType: 'gsd-executor', isolation: 'worktree', schema })` — the schema makes the executor return its worktree metadata as validated JSON |
| Plan (`use_worktree: false`) | `agent(brief, { agentType: 'gsd-executor' })` (no isolation) |
| `files_modified` overlap | forces the plans into separate sequential stages |
| Wave | a `phase("Wave <id>")` group, matching a `meta.phases` entry |
| Phase run id | `summary.resumeRunId` → pass as the Workflow tool's `resumeFromRunId` **input** |
| Phase token cap | recorded in `summary.budgetTokens`; `budget` is read-only in a script |

Because the emitted script composes the **same** `gsd-executor` agent the
inline path uses, with worktree isolation applied **per plan** from the
manifest's `use_worktree` field, it produces the same `SUMMARY.md` artifacts
and commits — the only difference is the execution vehicle. `use_worktree`
mirrors execute-phase.md step 2.5's per-plan submodule safety gate exactly: a
plan that touches a submodule path is never forced into worktree isolation,
whichever backend dispatches it ([#2772]).

The script hands each plan's result back as `{ plan, expects_worktree, metadata,
error }`. The worktree metadata used to be pulled out of the executor's prose with a
regular expression, so a reply that missed the expected block simply produced
`null`. Passing a JSON Schema on `agent()` moves that check into Claude Code, which
validates the reply and asks the executor to retry (up to five times). Each agent
call also catches its own failure, so one executor that fails leaves its error
text in `error` while the others in the same `parallel()` barrier still return.

Emission refuses a manifest Claude Code would refuse anyway — more than 4,096
plans in one `parallel()` call or more than 1,000 agents in one run — and says
which cap, rather than letting the run fail with an opaque error.

## The fallback contract

On any runtime lacking the Workflow tool — or when the capability is disabled,
workflows are turned off, or detection fails for any reason — execute-phase proceeds
with the standard inline wave dispatch. This is a release gate, not a nicety: a
regression test asserts the inline fallback on every non-capable combination, so
the capability is default-off and low-risk by construction.

## BETA scope (v1)

The first slice ships **detection + emission + declarative ultraplan ownership**.
The emitter is exercised at the contract level (structure, overlap splitting,
resume, budget, anti-injection). End-to-end execution through the Workflow tool
is verifiable only inside Claude Code with the tool present. Full install-profile
migration of the `gsd-ultraplan-phase` skill into the capability's `skills[]`
array is a follow-up (it touches the cluster/profile machinery); for v1 the
manifest *declares* ultraplan ownership at `plan:post` and the existing skill's
own runtime gate continues to no-op on non-Claude runtimes.

[#853]: https://github.com/open-gsd/gsd-core/issues/853
[#1143]: https://github.com/open-gsd/gsd-core/issues/1143
[#2772]: https://github.com/open-gsd/gsd-core/issues/2772
[#2285]: https://github.com/open-gsd/gsd-core/issues/2285
[#4740]: https://github.com/open-gsd/gsd-core/issues/4740
[#4747]: https://github.com/open-gsd/gsd-core/issues/4747
