# Codex native supervisor adapter for orchestrator-worktree executors

**Source:** [#4625](https://github.com/open-gsd/gsd-core/issues/4625)
**Decision:** wontfix — No-go as filed; the observability goal is redirected to EoS, behind [#4624](https://github.com/open-gsd/gsd-core/issues/4624)
**Date:** 2026-09-11

## Proposal summary

Reporter proposed an opt-in, Codex-only supervision adapter layered on the existing negotiated
`orchestrator-worktree` dispatch backend. For each selected executor the root would create the
existing GSD-managed worktree and launch one **native Codex supervisor subagent**, which owns
exactly one external `codex exec --cd <worktree>` worker and surfaces evidence-backed progress in
Codex's native subagent UI as three strict states:

- `executing` — the persisted worker process is alive after successful launch
- `verifying` — that process reached a terminal state and the supervisor is reconciling its
  result, SUMMARY, plan-scoped commits, branch and manifest
- `completed` — reconciliation succeeded and the manifest-only merge/cleanup gauntlet finished

The supervisor would run the worker in the foreground (explicitly not backgrounded with `&`
behind a cosmetic status), consume the persisted lifecycle protocol proposed in #4624, and be
disabled by default with no behavior change for other runtimes or the default direct adapter.

## Why GSD does not own this

- **The target surface cannot carry the states the proposal is built on.** Codex's native
  subagent status is a fixed two-value enum — `CollabAgentToolCallStatus::{InProgress,
  Completed}`, emitted by `wait_agent`. There is no free-text or custom status field. The
  proposal's `executing` / `verifying` / `completed` triad cannot be rendered in that view **by
  anyone, gsd-core included.** This is not a question of where the adapter lives, and it is the
  decisive ground: the feature's central promise is not deliverable as specified.

- **The native subagent list is populated only by Codex's own `spawn_agent` / `wait_agent`
  machinery.** `notify` (a fire-and-forget subprocess spawn on `agent-turn-complete`) and the
  `hooks.toml` command hooks observe Codex's *own* turn and tool events; neither is documented as
  rendering into that list. A framework that did not itself drive `spawn_agent` could not reach it.

- **That machinery is unreleased.** `multi_agents_v2` was found at source level on the `openai/codex`
  `main` branch and could not be verified as shipped or GA; the `--experimental-json` alias beside it
  points the same way. Committing a core-resident adapter to an unstable, unreleased third-party
  interface would be building ahead of the vendor.

- **A second core dispatch adapter is a permanent tax.** Every future change to the executor
  lifecycle would have to be made twice, or proven to apply to both paths. The graph rates the
  isolation resolver's blast radius MEDIUM, and `dispatch.isolation` is declared across multiple
  runtime capability descriptors, so an adapter is a multi-descriptor change rather than a local one.

Note what the proposal got **right**, none of which is a ground for rejection: the observability
gap it describes is real and was confirmed; its containment shape (opt-in, default-off, no change
to other runtimes or the default path) is the correct one for this class of change; its
self-imposed rule that a worker must never show `completed` merely because a process exited is
exactly the right invariant; and it correctly identified and filed its own correctness
prerequisite separately as #4624, which is now `confirmed-bug`. The filing was specific enough to
be checked against the runtime, which is why the mechanism problem surfaced at all.

## What this does NOT cover

This entry denies **gsd-core building a second, core-resident dispatch adapter around Codex's
native subagent UI.** Its keyword surface — supervisor, observability, worker state, lifecycle,
subagent, Codex, orchestrator-worktree — overlaps requests this decision deliberately does not
deny. Do not apply this entry to:

- **Worker-state visibility for Codex executors as a goal.** It is legitimate and it is reachable.
  `codex exec --json` emits structured JSONL `ThreadEvent`s — `thread.started` (carrying
  `thread_id`), `turn.started` / `turn.completed` / `turn.failed`, `item.*`, `thread.error` — and a
  session resumes via `codex exec --json resume <thread_id>`. That is a genuine terminal-state
  signal for an external worker, and nothing here denies using it.
- **#4624, the persisted lifecycle record.** That is a confirmed defect fix and core work
  regardless of this decision. Its diagnosis found the current `orchestrator-worktree` wait path is
  a single prose sentence with no captured PID and no durable per-worker record.
- **An EoS capability that reads that record and reports state.** Once a durable per-worker record
  exists on disk, a capability can register a `step` hook at `execute:wave:pre` /
  `execute:wave:post` (ADR-857's loop extension points) and display each worker's state with no
  core change of its own. **This is the sanctioned path for this request**, and it is open now.
- **Fixing the existing `orchestrator-worktree` adapter.** Defects in the shipped path are bug
  reports, not this proposal.
- **Codex runtime support generally** (`capabilities/codex/capability.json`), which is unaffected.

## Re-open criteria

- **Codex ships a documented, non-experimental surface that accepts a custom status string from a
  third party into its native subagent view.** This is the ground the decision actually rests on;
  if it changes, the decision should be revisited rather than cited. A resubmission should name
  the specific released Codex version and the surface.
- Separately, and only then: #4624 has shipped, and a resubmission **names a specific residual
  visibility failure observed after the EoS read-and-report path was tried** — rather than arguing
  for the native-UI adapter in the abstract.

A core-resident adapter is accepted here only once the surface it targets can carry the states it
was specified to show. Until then, the wave-boundary read of a persisted record is strictly more
capable than the thing this entry declines, because it can express states the native enum cannot.

## Related

- [#4624](https://github.com/open-gsd/gsd-core/issues/4624) — the persisted-lifecycle defect this
  was sequenced behind; `confirmed-bug`
- [`subagent-activity-watchdog.md`](./subagent-activity-watchdog.md) — denies a *generalized*
  event-driven watchdog; explicitly preserves narrow per-spawn-site work, and so does **not** deny
  the EoS path above
- [`codex-native-plugin-skips-preproposal.md`](./codex-native-plugin-skips-preproposal.md) — the
  standing no-new-first-party-add-ons policy; targets distribution surfaces, and so was **not** the
  ground for this decision
- [ADR-857](../docs/adr/857-capability-system.md) — the capability system and its 12 loop extension
  points
- `gsd-core/references/loop-hook-dispatch.md` — the `contribution` / `step` / `gate` hook contract
- `capabilities/codex/capability.json` — existing Codex runtime support, unaffected
