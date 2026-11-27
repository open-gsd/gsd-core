# ADR-3711: Cross-runtime plan execution — a per-plan `executor_runtime` on the `orchestrator-worktree` backend

- **Status:** Accepted
- **Date:** 2026-11-18
- **Issue:** [#3711](https://github.com/open-gsd/gsd-core/issues/3711) (`approved-feature`, go-with-conditions, maintainer verdict 2026-11-08); phase issue [#6300](https://github.com/open-gsd/gsd-core/issues/6300)
- **Amends:** [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) interface point 2 (Dispatch). The executor binary stops being a function of the host's identity alone: one plan may select a different registry entry's `orchestratorExec`.
- **Builds on:** [ADR-4630](4630-dispatch-identity-and-isolation-decision-seam.md) (the dispatch marker and the recorded isolation decision) · [ADR-857](857-capability-system.md) (hook model; hooks cannot mutate `Agent` input)
- **Related:** #1689 / #3417 (`agent_hint`, which names this follow-up), #2584 (`dispatch.isolation`), #2596 (declared-scope validation), #4624 (worker lifecycle record), #5682 (per-dispatch records), #3714 (`model` on `resolveOrchestratorExec`)

## Context

The executor that runs a plan is chosen by the host runtime and nothing else. `dispatch-isolation`
resolves a runtime id (`GSD_RUNTIME` > `config.runtime` > the per-install marker > `claude`), reads
`registry.runtimes[id].runtime.hostIntegration.dispatch.isolation`, and that one value decides how
every plan of every wave runs: `harness-worktree` (Claude, Cursor) passes the host's isolation flag
to an `Agent()` call; `orchestrator-worktree` (Codex, OpenCode, Kimi, Kimi Code) has GSD create the
worktree and process-spawn the executor with the descriptor's `orchestratorExec`
(`codex exec --cd`, `opencode run --dir`, …).

Two things follow for a developer who pays for more than one runtime:

1. A rate limit on the host stops the phase while another paid executor sits idle. The registry
   already knows how to spawn that executor, but only when it is the host.
2. Model fit cannot be expressed per plan. `agent_hint` (#3417) swaps a `subagent_type` inside the
   host's own agent directory, and its documented boundary is that the `orchestrator-worktree`
   backend has no `subagent_type` to swap. Reaching that backend *from* a `harness-worktree` host
   is the other half of that follow-up.

Four facts about the code shape the decision:

- **The backend already exists and is runtime-parameterized.** ADR-1239 built the
  `orchestrator-worktree` backend once for every such host, "parameterized by the host's exec
  invocation (descriptor data)". `executor-isolation-dispatch.md` composes the executor prompt there
  from the same text the harness path's `Agent()` call uses, with the harness-only framing removed,
  and carries the `[gsd:dispatch phase="…" plan="…"]` marker (ADR-4630 Decision 1).
- **Who commits is already settled on that backend.** The spawned executor commits each task in its
  own worktree; the orchestrator performs every other git operation (create, merge, cleanup) and
  merges serially through `executeWorktreeWaveCleanupPlan`, which stops the wave and keeps the
  worktree on a conflict. The Codex `workspace-write` sandbox makes the opposite arrangement
  unavailable there (ADR-1239 finding 1: `.git` is read-only and a worktree's gitdir lives in the
  main repository).
- **The worker already has a lifecycle record.** `worktree.worker-record`, `worker-status` and
  `worker-complete` persist `{agentId, pid, plan, worktreePath, summaryPath, logFile, state,
  exitCode}`, and the resume-first guard reconciles a worker "from its persisted record — SUMMARY +
  plan-scoped commits + branch state", never from narration (#4624).
- **The isolation decision is a recorded fact.** `dispatch-isolation` writes it as an unconditional
  side effect, keyed per dispatch (`.gsd/dispatch-isolation/<phase>--<plan>.json`, #5682), and the
  guard hooks read the record instead of re-deriving it (ADR-4630 Decision 2).

## Decision

### D1 — One optional plan field, one opt-in gate, both required

A plan may declare `executor_runtime: <runtime id>` in its frontmatter, parsed into the plan index
as `executor_runtime` (`null` when unset), next to `agent_hint`. The field has an effect only when
`workflow.cross_runtime_execution` is `true`; the key defaults to `false`, unlike
`agent_hint_routing`, because this path spends money on a second vendor and weakens the harness
guarantees described in D6. A project opts in twice: once in config, once per plan.

`executor_runtime` and `agent_hint` on one plan are a **validation error**, not a precedence rule:
one names a host subagent, the other a foreign process, and the difference in failure mode and
safety story is exactly what a reader of the plan must see.

### D2 — The target is a registry entry; the host's `isolation` does not decide

Selection reuses the registry. `executor_runtime` names `registry.runtimes[<id>]`; the target must
declare an `orchestratorExec` descriptor that `resolveOrchestratorExec` accepts. For that one plan
the resolved isolation is `orchestrator-worktree`, whatever the host's own `dispatch.isolation`
says, and the exec descriptor is the target's. Every other plan in the wave keeps the host's mode.

The condition that routes a plan is the resolved `ISOLATION` value for that plan, never a runtime id
(the fan-out invariant in `execute-phase.md`). No `runtime === 'codex'` branch is added anywhere.
A target whose `orchestratorExec` is undeclared is not a valid target.

### D3 — Every unhappy case degrades to the host's normal dispatch, with a one-line advisory

Fail-closed, consistent with ADR-1239 and with how `agent_hint` degrades. Each of these produces the
host's ordinary dispatch for that plan and one advisory line naming the reason, and never an
unisolated or silently skipped execution:

| Case | Reason code |
|---|---|
| gate unset or `false` | `gate_off` |
| unknown runtime id | `unknown_runtime` |
| target declares no `orchestratorExec`, or the descriptor does not resolve | `descriptor_unresolved` |
| target binary not on `PATH` (the `command-exists` probe `review-lane-descriptor` already uses) | `binary_absent` |
| `executor_runtime` equals the host runtime | `same_runtime` (not a foreign dispatch) |
| the project opted out of worktrees (`workflow.use_worktrees: false`) | `worktrees_off` |

With the gate off, a plan that declares the field dispatches byte-identically to today; plans without
the field are untouched in every configuration.

### D4 — Checkpoints refuse at validation time

A foreign process cannot raise a checkpoint back to the host. A plan with `autonomous: false`, or any
`checkpoint:*` task, is refused when `executor_runtime` is set, at plan validation (the same
validation that refuses the `agent_hint` conflict), with a message naming both fields. The refusal
is not deferred to dispatch time: a gate that the executor cannot reach must never be skipped quietly.

### D5 — Who commits: the worker commits in its worktree; the host validates scope at merge

This is the question the maintainer asked the ADR to decide. Two options:

| | Option A: the host is the only git writer | Option B: the worker commits in its own worktree, the host validates |
|---|---|---|
| Shape | The worker does one step per turn and answers a structured commit point (`{kind, task, type, subject, paths, notes}`); the host validates and commits | The worker runs the executor contract and commits each task; the host runs diff-scope validation (#2596) over those commits at merge |
| Fits the existing backend | No: it needs a turn-by-turn worker protocol, a resume-by-session mechanism and a commit-point schema that no descriptor or `worktree.worker-*` record has | Yes: it is what `orchestrator-worktree` already does for Codex, OpenCode and Kimi |
| Atomic-commit contract | A second copy: the host re-implements commit rules the executor prompt already carries | One copy: the executor prompt carries it |
| Strength | Per-step validation (a RED that must fail on assertions, a test-integrity diff check) before anything is committed | Scope and merge-base validation only, after the worker has committed |

**Decision: Option B.** One executor contract and one backend is the point of reusing
`orchestrator-worktree` (Gall's Law: grow from the working system). The host still owns every other
git operation and the single-writer `STATE.md` and `ROADMAP.md` invariant. Option A's per-step
validation is real value and is recorded as a candidate for a later ADR once a second consumer needs a
step-level protocol; it is not rejected on its merits, it is not needed to ship the first version, and
adopting it now would fork the executor contract that D6 commits to keep single.

The external commit-point protocol reported on 2026-10-16 is design input for that later ADR, not a
condition of this one.

### D6 — The prompt is rendered from the shared fragment; verification stays on the host

The foreign executor receives the **same composed prompt** the `orchestrator-worktree` path already
builds, with the `[gsd:dispatch phase="…" plan="…"]` marker so the guard hooks can scope the record.
The new `cross-runtime-executor-dispatch.md` fragment carries only what differs (target resolution,
the probe, the spawn, the records) and never a second copy of the executor contract or the
atomic-commit text. The prompt travels on the channel the descriptor declares (`promptFlag: null`
means stdin for Codex).

Verification does not move. Diff-scope validation (#2596), the plan drift guard and goal-backward
verification run on the host exactly as for a native executor; the foreign process writes code inside
its own worktree and nothing else. **Weaker guarantees, stated:** a spawned process is outside the
host's hook layer, so `PreToolUse` guards do not apply to it. The compensating controls are the
worktree boundary and the host-side validation, both already present, which is why the gate defaults
to off and D4 refuses checkpoint plans.

### D7 — Model and effort come from the target runtime, and the host's never leak

`resolveOrchestratorExec` accepts a `model` and a descriptor `modelFlag` (#3714). The model for a
foreign dispatch resolves from the **target runtime's own catalog**, through a new `execute.models.<runtime>`
key family modeled on `review.models.<lane>`, and never from the host's configuration. A row asserts
that the host's model does not appear in the spawned argv (#2297 and #3160 are the cross-runtime
poisoning this prevents). A target with no entry omits the flag, which the resolver already treats as
"use the target's default".

### D8 — Each dispatch writes its own decision and its own worker record

A cross-runtime dispatch writes an isolation decision to its own per-dispatch record, naming its
producer, and never re-derives it (ADR-4630 Decision 2). A query that holds a caller's `none` writes no
record (ADR-4630); the per-plan gate re-records the plan before the launch, so the launch's exec read
writes it. The worker gets a lifecycle record with the
target runtime recorded, and completion comes from reconciling that record (SUMMARY, plan-scoped
commits, branch state), never from the process exiting (#4624). A foreign process that exits 0 without
a SUMMARY or plan commits is not complete.

### D9 — The route is `dispatch-isolation`

The resolver is extended in place: `dispatch-isolation --plan <id> --cwd-target <path> --json` reports
`runtime` (the host), `executorRuntime`, `isolation`, `exec` and `fallback`, and keeps the sentinel
write as the sole persistence path. The shorter names in the issue text (`resolve-dispatch-isolation`)
are not used in code or docs. The output gains fields only; existing `--raw` consumers still read one
of the three vocabulary values.

## Alternatives considered

1. **Install GSD into the foreign runtime and run the pipeline there.** Rejected: it swaps the whole
   pipeline, not one plan; planning, review and verification agents move too, and project state ends up
   written by a runtime the developer chose for one plan.
2. **A `runtime:name` form of `agent_hint`.** Rejected: the two mechanisms differ in kind. One swaps a
   `subagent_type` inside the harness, the other spawns a process outside it. One overloaded field would
   hide that at the point a reader needs to see it (D1).
3. **A capability overlay.** Rejected: hooks cannot mutate `Agent` tool input and the pre-dispatch render
   seam does not exist (the reason #1689 recorded). Selecting an executor is a deterministic decision
   that belongs in the resolver.
4. **Rate-limit-aware automatic switching (#2291).** Rejected as scope creep and a different axis: it
   swaps providers inside one runtime. Here the developer chooses per plan, explicitly.
5. **Option A of D5 for the first version.** Deferred, not refused; see D5.

## Consequences

- **Positive.** A solo developer can finish a phase on a runtime already paid for, and route a
  mechanical plan to a cheaper executor, with the atomic-commit protocol, worktree isolation and state
  recording the native path has. No new dependency and no new backend.
- **Neutral for existing projects.** The gate is off by default and the field parses to `null` when
  unset, so dispatch is byte-identical until a project opts in twice.
- **Negative / forever-cost.** A second executor path to keep true: a change to wave scheduling, worktree
  base refs, the sentinel or the prompt composition now has two dispatch shapes to satisfy from one host.
  Foreign CLIs rename flags; a `codex exec` change now breaks execution as well as review, though the
  surface is the shared `orchestratorExec` descriptor rather than new code. The `execute.models.<runtime>`
  key family is new configuration surface.

## Delivery

Four phases, one PR each, in this order (the maintainer's accepted order):

1. **This ADR** (#6300). A maintainer owns, edits and accepts it before Phase 4.
2. **Fallback-arm tests** (#6301): written first, failing for the missing feature: flag off is
   byte-identical; unknown runtime, absent binary and unresolved descriptor each degrade; checkpoint and
   `agent_hint` conflicts are refused; the host model never appears in the spawned argv.
3. **Plan validation only** (#6302): the field, the gate, `execute.models.<runtime>`, the two refusals.
   No dispatch.
4. **Dispatch** (#6303): the `dispatch-isolation` extension, the fragment, the per-dispatch record and
   the worker record. It does not start until this ADR is `Accepted`.

## Known limits

- **Names are fixed.** `executor_runtime`, `workflow.cross_runtime_execution` and
  `execute.models.<runtime>` are the names the approved issue's acceptance criteria use; they become
  contract surface when Phase 3 ships.
- **No step-level commit protocol.** Option A of D5 is not built. A later ADR takes it up when a
  second consumer needs per-step validation that Option B cannot give.
