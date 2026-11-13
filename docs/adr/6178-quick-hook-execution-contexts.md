# ADR-6178: Execution contexts — quick tasks become an opt-in host for capability hooks

- **Status:** Proposed
- **Date:** 2026-11-13
- **Issue:** [#6178](https://github.com/open-gsd/gsd-core/issues/6178) (`approved-feature`, go-with-conditions: this ADR before code, three increments, compatibility test first)
- **Amends:** [ADR-857](857-capability-system.md) (the hook model gains an execution-context dimension next to point and kind) · [ADR-894](894-capability-declaration-format.md) (the hook entry schema gains `executionContexts`; the Loop Host Contract gains logical quick hosts)
- **Builds on:** [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (quick-batch binding: single-writer coordinator, `BATCH.json` as the source of truth for completion) · [ADR-1244](1244-capability-ecosystem.md) (`engines.gsd` as the compatibility gate for manifests that use the field)

## Context

[ADR-857](857-capability-system.md) defines capability hooks along two dimensions: a **point** (one of
the 12 Loop Extension Points) and a **kind** (step, contribution, gate).
[ADR-894](894-capability-declaration-format.md) makes the hosts publish which points they expose, and
the generator checks hooks against that contract. Both were written for the phase loop. Neither says
what a hook does when the work is a quick task.

In v1.21.0 the quick paths answer that question by accident:

| Path | What is dispatched |
|---|---|
| `/gsd-quick` | `plan:pre` planner contributions only (`quick.md`, per #3778). `execute:post` steps only in full mode, because the generic dispatch (#3606) sits inside Step 6.25 *Code review*, which is skipped unless `$FULL_MODE` is true. `execute:post` gates never. No `discuss:*` with `--discuss`, no `verify:*` with `--validate`. |
| `/gsd-quick-batch` | `plan:pre` planner contributions only (`quick-batch/steps/planner-wave.md`). Nothing else. |

Three consequences:

1. **A capability cannot finish work it started in a quick task.** Its planner contribution reaches
   the quick planner, but its `execute:post` step runs only when the user also asked for full mode.
   The motivating case is the community capability gsd-musk-simplification: its contribution records
   entries under `.planning/musk/`, and its `execute:post` step `musk commit` commits them. In a plain
   `/gsd-quick` the entries stay uncommitted.
2. **Hooks have no quick invocation contract.** Command steps run as
   `gsd_run <command> --phase "${PHASE_NUMBER}" --raw` (`references/loop-hook-dispatch.md`), and
   `quick.md` never sets `PHASE_NUMBER`. A step gets an empty or an inherited phase, and nothing
   tells it which quick task it runs for.
3. **The generator cannot see it.** `validateHooksWired` checks that *some* file in `HOST_LOOP_FILES`
   covers each point and kind, as a union across hosts. Quick's narrowed `execute:post` passes because
   `verify-phase-goal.md` covers the kinds, and `quick-batch/**` is not scanned at all.

**Dispatching every active hook in quick is not the fix.** Moving the `execute:post` dispatch out of
the code-review step would run the bundled refactor-trigger step (`refactor evaluate --phase N`, which
writes `.planning/phases/<N>/<NN>-REFACTOR.md`) on every plain quick task once `refactor.trigger_enabled`
is on. With an empty phase the command rejects the call; with a phase inherited from the session it
evaluates the wrong phase and writes into it. Research, drift and the tdd gate are phase-sized too.
Whether a hook makes sense in a quick task is a property of the hook, not of the point.

**Self-gating inside the hook is not the fix either.** [ADR-894](894-capability-declaration-format.md)
keeps `when` config-only and lets a skill no-op when its context does not apply. That works when the
hook is dispatched and can tell where it is. Here neither holds reliably: quick does not dispatch most
points, and there is no structured quick contract. Planner contributions do land in a prompt that names
the quick directory, description and planning mode, but only as prose around them; command steps get
`--phase` and nothing that identifies the quick task.

## Decision

### D1 — A third dimension: execution context

A hook entry (step, contribution or gate) gains an optional field:

```jsonc
{ "point": "execute:post", "ref": { "command": "musk commit" },
  "when": "musk.enabled", "onError": "skip",
  "executionContexts": ["phase", "quick"] }
```

The values are `"phase"` and `"quick"`. The vocabulary is closed and additive-only, like the point
names.

| Field value | Phase loop | Quick paths |
|---|---|---|
| absent (**unannotated**) | as today | **exactly as v1.21.0**, including its gaps |
| `["phase", "quick"]` or `["quick"]` (**annotated**) | as today if `"phase"` is listed, never otherwise | the quick contract (D2, D3) |
| `["phase"]` | as today | never, not even the v1.21.0 legacy dispatch (explicit opt-out) |

Two kinds of filtering are kept apart:

- **Activation filters** (capability enabled, `when`, `pointFrom`) apply to every hook as today. The
  context check runs after them and never activates a hook they reject.
- **Host scheduling** (whether and when a call site runs) depends on the hook's annotation. Unannotated
  hooks keep v1.21.0 scheduling, including `execute:post` only under `$FULL_MODE`. Annotated hooks are
  scheduled by the D2 matrix, so an annotated `execute:post` step runs in a plain `/gsd-quick` even
  though the legacy call site would not.

An unannotated hook keeping its legacy quick dispatch is deliberate. Existing bundled and third-party
manifests rely on today's behavior (planner contributions in quick, `execute:post` steps under
`--full`). Changing what they do without their authors opting in is the break this ADR avoids.

A manifest that uses the field declares an `engines.gsd` floor at the first version that supports
**every quick cell (point × host) it relies on**, not just the version that introduced the field. The increments
ship separately, so `references/loop-hook-dispatch.md` records the version each D2 cell became
supported. Two mechanisms close the gap:

- Hosts older than the field ignore it and keep their legacy dispatch, which is safe but not what the
  author asked for. The floor makes that an install-time error under
  [ADR-1244](1244-capability-ecosystem.md) instead of a silent difference.
- Hosts that know the field validate annotations by point (D2). An annotation for a point no quick
  host supports in the running version is a validation error, never a silent no-op.

### D2 — The quick support matrix

Core owns one matrix of what the quick hosts dispatch for annotated hooks. It is documented in
`references/loop-hook-dispatch.md` and enforced by the generator (D5). C = contribution, S = step,
G = gate.

| Point | `/gsd-quick` | `/gsd-quick-batch` |
|---|---|---|
| `plan:pre` | Always. S and G before the planner spawns; C into `planner`. | Per planning invocation (D3, D4). |
| `execute:post` | After successful execution, **whatever the flags**. S and G. | Per item, serially, after the item's merge (or after execution with `ISOLATION=none`), before the final batch commit. |
| `verify:pre` | With `--validate`, before the verifier. S and G; C into `verifier`. | Per item, with `--validate`. |
| `verify:post` | With `--validate`, after the verifier. S and G. | Per item, with `--validate`. |
| `discuss:pre` / `discuss:post` | With `--discuss`. S and G; C into `orchestrator` at `discuss:pre`. | Not applicable (`--discuss` is rejected). |
| `plan:post`, `execute:pre`, `execute:wave:*`, `ship:*` | Not supported. | Not supported. |

The `"quick"` context covers both hosts; a manifest does not pick one. Validation and dispatch
therefore work at different granularities:

- **Validation is per point.** Annotating a hook for `"quick"` at a point that *no* quick host
  supports in the running version (`plan:post`, `execute:pre`, …, or `verify:*` before increment 2)
  is a manifest validation error.
- **Dispatch is per cell.** Each host dispatches an annotated hook only at the cells it supports. A
  cell that does not apply to a host (`discuss:*` in quick-batch) is permanently skipped there. A cell
  not yet delivered (quick-batch `execute:post` before increment 3) is skipped too, exactly as v1.21.0
  skips it.
- **Each cell records its first supported version** in `references/loop-hook-dispatch.md`. An author
  who needs a specific cell sets the `engines.gsd` floor to that version (D1).

Failure semantics are those of [ADR-894](894-capability-declaration-format.md) and
`references/loop-hook-dispatch.md` per kind, unchanged in quick: a step is additive and never halts
the host (an erroring step is skipped with a warning). A gate stops a quick task when it fails with
`blocking: true`, or when it errors under `onError: halt`.

Built-in code review is not part of the matrix. It stays a full-mode specialization of `/gsd-quick`,
runs once, and quick-batch gains none.

### D3 — The quick invocation contract

Annotated hooks dispatched on a quick path receive quick context instead of phase context:

- **Command steps and query gates** run with `--quick "<quick_id>" --quick-modes <set>` instead of
  `--phase`. A quick id is never passed as a phase number.
- **Skill steps, agent steps, gates and contributions** receive the quick id, the task directory
  (`.planning/quick/<id>-<slug>/`), the working directory, the resolved modes, and the batch id when
  there is one.
- **Resolved modes** are the set of `discuss`, `research` and `validate` after quick's flag
  normalization, so `--full` and the three granular flags yield the same set. Raw arguments are never
  passed.
- **The task description never goes on a command line.** It is free user text. Before the first hook
  runs, core writes it and the resolved modes to `<quick_id>-TASK.json` in the task directory, and
  hooks read them from there. This keeps the dispatch contract's rule that command arguments are
  validated, not interpolated.
- **Batch `plan:pre` is per planning invocation.** Planning recomputes waves and only plans pending
  items, so a layer number does not identify a stable item set across resumes. Each planning dispatch
  gets a planning-invocation id, persisted with its item membership before any hook runs (D4). Hooks
  receive the batch id, that id and the items (quick ids and task directories). Command steps get
  `--quick-batch "<batch_id>" --planning "<invocation_id>"` and the batch's resolved modes.
- **Per-item batch hooks** see the coordinator's checkout after that item's merge. Items merged
  earlier in the same wave may already be present.

An annotated hook accepts this contract. That is the meaning of listing `"quick"`.

### D4 — quick-batch dispatches through the coordinator, with checkpoints

quick-batch dispatches hooks from its coordinator through the same shared primitives, never by
running `/gsd-quick` per item. [ADR-1239](1239-gsd-embeddable-orchestration-engine.md)'s single-writer
ownership of `BATCH.json`, STATE.md and worktree merges is unchanged.

- **The hook schedule is frozen when the batch starts.** `BATCH.json` moves from `schema_version: 1`
  to `2`, which records the resolved annotated hooks per point. A capability enabled or disabled mid-batch does not
  change a running batch. Each planning invocation is persisted (id, item membership, hook snapshot)
  before its hooks run.
- **Hook identity** is capability id, point, kind and the entry's index in its typed manifest array
  (`steps`, `contributions` or `gates`; not the lifecycle `hooks`), so two entries from one capability
  at one point stay distinct.
- **Contributions are snapshots, not checkpoints.** A contribution is prompt content, not a side
  effect. Its resolved fragment is stored with the frozen schedule and injected into every spawn of the
  target agent, including replacement and revision spawns after a resume. It is never marked done.
- **Steps and gates are checkpointed:** per-item hooks by item, point and hook identity; `plan:pre`
  hooks by planning invocation, point and hook identity. Step outcomes are `ok`, `skipped` and `error`;
  per [ADR-894](894-capability-declaration-format.md) a step never halts. Gate outcomes are `passed`,
  `failed` (a non-blocking gate failed), `error-skipped` (the gate errored under `onError: skip`, no
  verdict) and `blocked` (a blocking gate failed, or the gate errored under `onError: halt`).
- **An item is complete only when every step and gate scheduled for it has an outcome.** `blocked`
  leaves it incomplete and goes through the existing failure routing. This narrows what "complete"
  means: completion recovery currently infers it from the item's STATE row, and must also consult the
  ledger, so an item whose row exists but whose hooks have no outcome is resumed for those hooks.
- **`--resume` never replays a recorded outcome** and runs checkpointed hooks that have none. There is
  no retry policy beyond `onError`.
- **No exactly-once guarantee.** A crash between a hook's side effect and its checkpoint re-runs that
  hook. Annotated steps and gates must be idempotent, and the authoring docs say so.
- **Commits made by hooks** are reconciled against the batch's `base_revision` check before resume
  compares it with HEAD.
- **Batches started before the upgrade** carry `schema_version: 1` and no frozen schedule. They
  resume entirely under v1.21.0 dispatch: completed items stay complete as
  [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) requires, and no annotated hook runs
  retroactively for any of their items. The contract applies from the next batch.

### D5 — Logical hosts and per-host coverage

The Loop Host Contract ([ADR-894](894-capability-declaration-format.md) §3) gains **logical hosts**: a
workflow together with its step files. `quick` (`quick.md`, `quick/steps/**`) and `quick-batch`
(`quick-batch/**`) are logical hosts. For them, the generator checks every point, kind and
contribution target that D2 claims, per host and not as a union, including whether the gating flag can
reach the call site.

`produces`/`consumes` is checked per logical host, against the points that host actually schedules
and the modes that gate them, not per context. Both hosts share the `"quick"` context but schedule
different points: a `discuss:post` producer can satisfy a consumer in `quick`, never in `quick-batch`.
Today's validator pools producers globally (`capability-validator.cjs`); the quick hosts get their own
pools. A consumer whose producer only runs under an optional mode must degrade gracefully when it
did not run, as [ADR-894](894-capability-declaration-format.md) already requires of self-gated
producers.

The phase hosts keep the existing union check. Converting them to per-host coverage is out of scope.

## Delivery

Three increments, each its own PR. The compatibility test lands first and stays green throughout: an
unannotated manifest dispatches exactly as v1.21.0 on every quick and quick-batch path and flag set.

1. **The field and `/gsd-quick` `execute:post`.** Schema and validation (D1, the unsupported-point
   error), context filtering in `loop render-hooks --context quick`, the D3 contract including
   `<quick_id>-TASK.json`, and an `execute:post` dispatch for annotated hooks that runs whatever the
   flags. The logical `quick` host and its coverage check for `plan:pre` and `execute:post`.
2. **`verify:*` and `discuss:*` in `/gsd-quick`.** Dispatch in the two step files, contribution
   targets `verifier` and `orchestrator`, coverage extended to them.
3. **quick-batch.** The logical `quick-batch` host, per-invocation `plan:pre`, per-item `execute:post`
   and `verify:*`, the versioned `BATCH.json` with the frozen schedule, and the D4 ledger in completion
   recovery.

Each increment adds its D2 cells to the matrix with their first supported version, so a manifest's
`engines.gsd` floor can name the version that supports everything it annotates.

Each increment updates `references/loop-hook-dispatch.md`, the capability how-to and tutorial, the
quick-task how-to, the CLI surface manifest where the CLI changes, and carries an `Added` changeset.

## Consequences

- **Positive.** A capability can declare that it understands quick tasks and get a defined set of
  points, kinds and arguments there. Authors can read what quick does instead of reverse-engineering
  the workflows. The generator catches a quick call site that drifts from the matrix.
- **Neutral for existing manifests.** Unannotated hooks keep v1.21.0 behavior, gaps included. The
  legacy quick dispatch stays until a future ADR decides to retire it; this ADR does not.
- **Negative.** Two dispatch paths coexist in quick (legacy for unannotated hooks, the contract for
  annotated ones), and the matrix is one more thing to keep in step with the workflows. quick-batch
  recovery gains state. Annotated hooks carry an idempotency obligation.

## Alternatives considered

1. **Dispatch every active hook in quick.** Rejected: phase-bound work (refactor-trigger, the tdd
   gate, research, drift) would run on every quick task with an empty or inherited `--phase`.
2. **Only move quick's `execute:post` dispatch out of the code-review step.** Rejected for the same
   reason, and it leaves `verify:*`, `discuss:*` and quick-batch undefined.
3. **A core allow-list of capability ids allowed in quick.** Rejected: permanent maintenance of
   third-party capabilities in core.
4. **A host-aware `when`.** Rejected: [ADR-894](894-capability-declaration-format.md) keeps `when`
   config-only and deterministic. An invocation predicate would extend the predicate model, and writing
   invocation state into config is unsafe with concurrent tasks.
5. **A core matrix without a per-hook field.** Rejected: it says what quick can host, not whether a
   given hook understands quick tasks.
6. **Default unannotated hooks into the new contract.** Rejected: it changes existing manifests'
   behavior without their authors' consent (Hyrum's law), which is what D1 exists to prevent.
7. **quick-batch runs `/gsd-quick` per item.** Rejected: it creates a second shared-state writer,
   which [ADR-1239](1239-gsd-embeddable-orchestration-engine.md)'s quick-batch binding forbids.

## Open questions

- **Field name.** `executionContexts` is the working name; it should be settled before increment 1
  merges, since the vocabulary is a stability contract.
- **`fast`.** `/gsd-fast` runs inline with no hooks at all. Whether it becomes a third context is left
  to a later issue.
