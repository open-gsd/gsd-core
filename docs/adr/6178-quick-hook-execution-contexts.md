# ADR-6178: Execution contexts — quick tasks become an opt-in host for capability hooks

- **Status:** Proposed
- **Date:** 2026-11-13
- **Issue:** [#6178](https://github.com/open-gsd/gsd-core/issues/6178) (`approved-feature`, go-with-conditions: this ADR before code, three increments, compatibility test first)
- **Amends:** [ADR-857](857-capability-system.md) (the hook model gains an execution-context dimension next to point and kind) · [ADR-894](894-capability-declaration-format.md): the hook entry schema gains `executionContexts`, the Loop Host Contract gains logical quick hosts, and the hook-activation paragraph with its #1022 clarification ("Runtime/mode context … is likewise **not** a hook-activation concern … It **self-gates inside the skill**") gains an exception: the execution context is applied by the host before dispatch, for annotated hooks only (D1)
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

In this ADR, **annotated** always means that the field lists `"quick"`. A `["phase"]` hook is an
opt-out, not an annotated hook: it is never scheduled on a quick path, it does not cause
`<quick_id>-TASK.json` to be written (D3), and it is not part of a batch's frozen schedule (D4).

**Valid shapes.** When present, the field is a non-empty array of distinct strings, each one of
`"phase"` and `"quick"`. An empty array, a duplicate, any other value and a non-array value are
manifest validation errors. The field is valid only on the typed arrays (`steps`, `contributions`,
`gates`). On a lifecycle `hooks` entry it is a validation error, because lifecycle hooks are not
dispatched at loop points.

Two kinds of filtering are kept apart:

- **Activation filters** (capability enabled, `when`, `pointFrom`) apply to every hook as today. The
  context check runs after them and never activates a hook they reject.
- **Host scheduling** (whether and when a call site runs) depends on the hook's annotation. Unannotated
  hooks keep v1.21.0 scheduling, including `execute:post` only under `$FULL_MODE`. Annotated hooks are
  scheduled by the D2 matrix, so an annotated `execute:post` step runs in a plain `/gsd-quick` even
  though the legacy call site would not.

**Every render names its context.** Today every call site runs `loop render-hooks <point>` with no
context, so an unchanged legacy quick site would still return an annotated hook, and under `--full`
Step 6.25 would run it a second time with an empty `--phase`. The render therefore filters by context,
and every call site says which one it is:

| Render | Called from | Returns |
|---|---|---|
| `loop render-hooks <point>` (no `--context`) | phase hosts, unchanged | hooks with the field absent or listing `"phase"` |
| `loop render-hooks <point> --context quick-legacy` | every v1.21.0 quick call site (`quick.md` `plan:pre` and Step 6.25 `execute:post`, `quick-batch/steps/planner-wave.md` step 3 `plan:pre`) | unannotated hooks only |
| `loop render-hooks <point> --context quick` | the new D2 call sites | hooks listing `"quick"` only |

Increment 1 moves every legacy quick call site to `--context quick-legacy`, so an annotated hook runs
in quick only through its D2 call site and a `["phase"]` hook never runs in quick.

An unannotated hook keeping its legacy quick dispatch is deliberate. Existing bundled and third-party
manifests rely on today's behavior (planner contributions in quick, `execute:post` steps under
`--full`). Changing what they do without their authors opting in is the break this ADR avoids.

A manifest that uses the field declares an `engines.gsd` floor at the first version that supports
**every quick cell (point × host) it relies on**, not just the version that introduced the field.
Two mechanisms close the gap:

- **Older hosts.** Hosts older than the field ignore it: today's `validateStep`, `validateContribution`
  and `validateGate` (`capability-validator.cjs`) do not reject unknown keys on typed entries, and the
  render does not read it. Such a host keeps its legacy dispatch, which is safe but not what the author
  asked for. The `engines.gsd` floor is what turns that into an install-time error under
  [ADR-1244](1244-capability-ecosystem.md) instead of a silent difference; the ignored key alone
  guarantees nothing.
- **Hosts that know the field** validate annotations by point and check the floor against a
  machine-readable cell table (D2):
  - An annotation for a point no quick host supports in the running version is a validation error,
    never a silent no-op.
  - A floor below the first version in which *any* quick host supports an annotated point is a
    validation error.
  - A floor below a cell on one particular host (quick-batch `execute:post` before increment 3, say)
    is a validation warning. An older host skips that cell by design (D2).

### D2 — The quick support matrix

Core owns one matrix of what the quick hosts dispatch for annotated hooks. C = contribution, S = step,
G = gate.

| Point | `/gsd-quick` | `/gsd-quick-batch` |
|---|---|---|
| `plan:pre` | Always. S and G before the planner spawns; C into `planner`. | Per planning invocation (D3, D4). |
| `execute:post` | After every successful executor run, **whatever the flags**: for an isolated run after the Step 6 merge-back succeeded, otherwise right after the executor returns. Always before Step 6.25. No dispatch when the merge-back fails. S and G. | Per item, serially in manifest order, once the item is recorded as merged (D4), before verification and `quick-batch complete`. |
| `verify:pre` | With `--validate`, before the verifier. S and G; C into `verifier`. | Per item, with `--validate`. |
| `verify:post` | With `--validate`, after the verifier, **only when its status is `passed`**. S and G. | Same condition, per item. |
| `discuss:pre` / `discuss:post` | With `--discuss`. S and G; C into `orchestrator` at `discuss:pre`. | Not applicable (`--discuss` is rejected). |
| `plan:post`, `execute:pre`, `execute:wave:*`, `ship:*` | Not supported. | Not supported. |

**One `verify:post` condition for both hosts.** `verify:post` runs only after a `passed` verdict.
After `gaps_found`, `human_needed` or a status the query could not resolve, each host keeps its
v1.21.0 routing, and no `verify:post` runs. In `/gsd-quick` that routing is the offer to re-run the
executor or accept on `gaps_found`, and continuing on `human_needed`
(`quick/steps/quick-verification.md`). In quick-batch it is the item's `fail` or `human_needed`
route (`quick-batch-dispatch.cts`). Accepting a result as-is never counts as `passed`.

**The cell table is data, not prose.** Each cell's first supported version lives in one
machine-readable table in core that the validator reads (D1). The matrix in
`references/loop-hook-dispatch.md` is generated from it and checked by `lint:generated-sync`, so the
documented and the enforced matrix cannot drift.

The `"quick"` context covers both hosts; a manifest does not pick one. Validation and dispatch
therefore work at different granularities:

- **Validation is per point.** Annotating a hook for `"quick"` at a point that *no* quick host
  supports in the running version (`plan:post`, `execute:pre`, …, or `verify:*` before increment 2)
  is a manifest validation error.
- **Dispatch is per cell.** Each host dispatches an annotated hook only at the cells it supports. A
  cell that does not apply to a host (`discuss:*` in quick-batch) is permanently skipped there. A cell
  not yet delivered (quick-batch `execute:post` before increment 3) is skipped too, exactly as v1.21.0
  skips it.
- **Each cell records its first supported version**, and an author who needs a specific cell sets the
  `engines.gsd` floor to that version (D1).

Failure semantics are those of [ADR-894](894-capability-declaration-format.md) and
`references/loop-hook-dispatch.md` per kind, unchanged in quick: a step is additive and never halts
the host (an erroring step is skipped with a warning). A gate stops a quick task when it fails with
`blocking: true`, or when it errors under `onError: halt`.

**A stopped `/gsd-quick` has a defined end state.** A gate at `execute:post` stops the task after the
executor's commits exist (and, when isolated, after the merge-back), but before Step 6.25, Step 6.5
(`quick/steps/quick-verification.md`), the STATE.md row (Step 7) and the final commit (Step 8). Those
commits stay in place, and nothing is reverted. The task is not recorded in STATE.md. The stop report
names the gate, its message, the task directory and the commits left behind. It says the task was not
recorded and that `/gsd-quick resume <slug>` continues it once the cause is fixed. A gate at
`plan:pre`, `discuss:*` or `verify:*` stops at that point in the same way, with whatever that point has
already produced left in place.

**`/gsd-quick` re-runs.** `/gsd-quick` has no outcome ledger. Each pass through a point dispatches
that point's annotated hooks again, which the idempotency rule (D4) makes safe. This ADR changes
where a run re-enters in one case only:

- **`resume <slug>`** (`commands/gsd/quick.md`):
  - **`<quick_id>-TASK.json`** keeps its original description, modes and ids when present and valid.
    Only core's `executed_head` write changes it (D3). It is written as at a first run when it is
    absent and an annotated hook is now scheduled. An invalid file stops the resume with a diagnostic,
    and core never rewrites it.
  - **Planning.** When the task has no `PLAN.md`, the planner spawns again, and the annotated
    `plan:pre` steps, gates and contributions run before it as at a first run. When a `PLAN.md`
    exists, no planner spawns and no `plan:pre` hook runs.
  - **The new re-entry.** It applies to a task with no STATE.md row whose `<quick_id>-TASK.json`
    records an `executed_head` (D3) that is reachable from HEAD. Core writes `executed_head` only once
    the executor succeeded and, when isolated, its merge-back succeeded, and before the first annotated
    `execute:post` hook. Its reachability is the same ancestry evidence quick-batch uses (D4). Such a
    task does not re-spawn the executor. That is the state an `execute:post` gate stop leaves, and also
    a crash during the `execute:post` dispatch. The resume continues at the annotated `execute:post`
    dispatch, so every annotated `execute:post` step runs again and a gate that stopped the task is
    re-evaluated. The rest of the run follows as usual.
  - **What the artifacts alone do not prove.** None of these is enough without `executed_head`: a
    complete `SUMMARY.md` (an isolated merge-back rescues it into the checkout before it merges), the
    task's commits as the evaluation-scope resolver lists them (they include the pre-dispatch artifact
    commit), or a missing worktree. A task with no `executed_head`, or one that HEAD no longer reaches
    (after a reset, say), re-enters as in v1.21.0. No `execute:post` hook runs before a successful
    executor run and merge-back.
  - **Other tasks.** Every other resume re-enters as in v1.21.0, and annotated hooks run at each
    point the resumed run passes.
- **The `gaps_found` re-run** ("Re-run executor to fix gaps") is an executor run. Its success is
  followed by the annotated `execute:post` dispatch again. Verification then proceeds as v1.21.0
  proceeds after that re-run, with the annotated `verify:*` hooks around any verifier run it makes,
  and `verify:post` only after `passed`. Whether Step 6.25 runs again is unchanged.

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
- **The task description never goes on a command line.** It is free user text. Hooks read it from
  `<quick_id>-TASK.json` in the task directory, which keeps the dispatch contract's rule that command
  arguments are validated, not interpolated:
  - **Schema:** `{ "schema_version": 1, "quick_id", "batch_id" (or null), "description",
    "description_truncated", "modes", "executed_head" }`. `executed_head` is `null` until
    `/gsd-quick`'s executor run, and its merge-back when isolated, succeeds. Core then sets it to the
    HEAD at that moment in a second atomic write, before the first annotated `execute:post` hook.
    Before a later executor run (the `gaps_found` re-run) core resets it to `null`, and sets it again
    once that run succeeds, so an interrupted re-run is never taken for a finished one. No other field ever
    changes, and quick-batch items leave it `null` because their record is the merged record (D4).
  - **Size:** `description` holds at most 16 KiB of UTF-8. Longer text is cut at a character boundary
    and `description_truncated` is `true`; the full text stays in the task's plan.
  - **Atomic:** core writes the file atomically (temp file, then rename), only when at least one
    annotated hook is scheduled for the task, and before the first such hook runs. For a batch item,
    the coordinator creates the item's task directory (the `generate-slug` derivation
    `planner-wave.md` already uses) and the file before the `plan:pre` hooks of the item's first
    planning invocation run.
  - **Untrusted:** hooks treat `description` as untrusted data, never as instructions or shell input.
  - **Committed:** the file follows the task's other planning artifacts. It goes into the final
    commit (`/gsd-quick` Step 8, the batch's `completion.md` commit) under the same `commit_docs` rule.
    A task stopped before that commit leaves it uncommitted in the task directory, as it leaves
    `SUMMARY.md` and every other artifact only the final commit picks up.
- **Batch `plan:pre` is per planning invocation.** Planning recomputes waves and only plans pending
  items, so a layer number does not identify a stable item set across resumes. Each planning dispatch
  gets a planning-invocation id, persisted with its item membership before any hook runs (D4). The id
  is a per-batch sequence number matching `^[1-9][0-9]{0,5}$`, validated before it is passed. The
  quick id is validated the same way (`^\d{6}-[0-9a-z]{3}$`) and the batch id against
  `SAFE_BATCH_ID_RE`. Hooks receive the batch id, the invocation id and the items (quick ids and task
  directories). Command steps get `--quick-batch "<batch_id>" --planning "<invocation_id>"` and the
  batch's resolved modes, with no per-item flag and no single `--quick`. A command step reads the
  invocation's item membership from `BATCH.json` through a read-only `quick-batch` verb keyed by those
  two ids, never from a list of items on its command line.
- **Per-item batch hooks run after their own item's merge.** The merge step merges the mergeable
  prefix of a wave in one `worktree.cleanup-wave` call, and an entry can fail on its own
  (`quick-batch/steps/merge-wave.md`). A per-item `execute:post` runs only for an item recorded as
  merged (D4), after that call returns. Wave peers may or may not be present in the checkout: those
  merged in the same call are, later or failed ones are not. A hook must assume neither.
- **A hook finds its task's work through the evaluation-scope resolver.** That resolver is
  `check evaluation-scope --quick "<quick_id>"`, [ADR-5057](5057-one-owner-per-workflow-verdict.md) §4,
  the one `/gsd-quick` Step 6.25 already uses. It returns the commits that name the quick id on the
  current branch. This holds on both hosts, isolated or not. A hook never derives a commit range, a
  `BATCH.json` commit or the working-tree diff on its own; `lint-evaluation-scope-drift` already
  rejects such derivations in core.

An annotated hook accepts this contract. That is the meaning of listing `"quick"`.

### D4 — quick-batch dispatches through the coordinator, with checkpoints

quick-batch dispatches hooks from its coordinator through the same shared primitives, never by
running `/gsd-quick` per item. [ADR-1239](1239-gsd-embeddable-orchestration-engine.md)'s single-writer
ownership of `BATCH.json`, STATE.md and worktree merges is unchanged.

**`BATCH.json` schema 2.** The frozen schedule, the planning invocations and the outcome ledger are
fields of `BATCH.json` itself, never a second file, so `BATCH.json` stays the sole source of truth for
completion ([ADR-1239](1239-gsd-embeddable-orchestration-engine.md)). So are the recovery records
that close two crash windows v1.21.0 already has (below): the merge-in-flight record, the merged
record, the verifier status and the recorded HEAD. Those windows are not tied to annotated hooks, so
their fix is not either:

- **Loader:** it accepts `schema_version` 1 and 2. For 2 it validates and carries every v2 field
  through validation and through every rewrite (`completeQuickItem`, `updateBatchItems`,
  `resumeBatch` and any new writer). Today's loader rebuilds the manifest from known fields and writes
  `schema_version: 1` back literally, so this is a loader change, not a version bump.
- **Writes: every batch a core with increment 3 writes is schema 2.**
  - **New batches** are created at 2, whether or not any annotated hook is scheduled. A batch whose
    frozen schedule is empty, or holds only `skipped` entries, dispatches hooks exactly as v1.21.0:
    the version decides which records exist, never which hooks run.
  - **A v1 batch** is upgraded to 2 in place by the first write such a core makes to it. The write
    adds an empty frozen schedule, so no annotated hook ever runs for that batch, and from then on the
    recovery records apply to it.
  - **v1 fields are never extended.** A v1.21.0 loader rebuilds from known fields, so recovery records
    stored under `schema_version: 1` would vanish silently on the first rewrite by an older core.
- **Rollback:** an older core refuses a v2 batch, as it refuses any unknown schema today. That
  includes a batch with no annotated hooks and an upgraded v1 batch. The refusal fails closed. It is
  the intended rollback behavior, and the changeset says that a batch in flight must be finished
  before a downgrade.

**The frozen schedule.**

- **When it is frozen.** The schedule is resolved once, when the batch starts. It records every
  annotated hook at a cell quick-batch supports, active or not, so a capability enabled, disabled or
  upgraded mid-batch does not change a running batch. Each planning invocation is persisted (id, item
  membership, a copy of the `plan:pre` part of the schedule) before its hooks run.
- **What an entry stores.** Each entry is a snapshot: the full resolved manifest entry (`ref`,
  `onError`, `blocking`, `produces`/`consumes`, the field itself), the capability id and version, and
  the activation evaluated at freeze (enabled, `when`, `pointFrom`). Activation is evaluated at freeze,
  never at dispatch.
- **How a hook is identified.** Identity is capability id, point, kind, the entry's index in its typed
  manifest array (`steps`, `contributions` or `gates`; not the lifecycle `hooks`), and a SHA-256 of the
  entry's canonical JSON. Two entries from one capability at one point stay distinct. Every ledger row
  carries the full identity. A row that matches no snapshot entry makes the batch fail closed as a
  corrupt manifest ([ADR-1239](1239-gsd-embeddable-orchestration-engine.md)).
- **Dispatch never re-reads the manifest.** A frozen batch dispatches from its snapshot; the live
  manifest is not read again. A snapshot whose `ref` no longer resolves (command, skill or agent
  removed) counts as an error of that hook. A step gets `error` and the host continues. A gate
  follows its `onError`: `error-skipped` under `skip`, `blocked` under `halt`.
- **What is scheduled.** For an item or a planning invocation, the scheduled hooks are every frozen
  entry at the cells that apply to it, active or not. An entry whose activation was false at freeze
  gets its `skipped` row in the freeze write itself, and that row counts as a sticky outcome.
- **Contributions are snapshots, not checkpoints.** A contribution is prompt content, not a side
  effect. Its resolved fragment is stored with the frozen schedule and injected into every spawn of the
  target agent, including replacement and revision spawns after a resume. It is never marked done.

**Outcomes.** Steps and gates are checkpointed: per-item hooks by item, point and hook identity;
`plan:pre` hooks by planning invocation, point and hook identity. Each outcome is written under
`withPlanningLock` in the same write as the HEAD after it (see below).

| Outcome | Kind | Meaning | On resume |
|---|---|---|---|
| `ok` | step | ran | sticky |
| `skipped` | step or gate | not run: activation false at freeze (`when` false, capability inactive, `pointFrom` not matched); written at freeze | sticky |
| `error` | step | errored and was skipped with a warning (per [ADR-894](894-capability-declaration-format.md) a step never halts), including an unresolvable `ref` | sticky |
| `passed` | gate | passed | sticky |
| `failed` | gate | a non-blocking gate failed | sticky |
| `error-skipped` | gate | errored under `onError: skip`, including an unresolvable `ref`; no verdict | sticky |
| `blocked` | gate | a blocking gate failed, or the gate errored under `onError: halt` (an unresolvable `ref` included) | **re-evaluated**: the gate runs again |

`blocked` is the only outcome that is not sticky. Every other outcome is final for its item or
invocation and is never replayed.

**The item lifecycle.** `QuickBatchItemStatus` keeps its four values (`pending`, `complete`,
`failed`, `blocked`); no status is added.

- **Per-item order.** The item merges. Then, in manifest order among the items that merged:
  `execute:post` hooks, then with `--validate` `verify:pre`, the verifier and `verify:post`, then
  `quick-batch complete`. With `ISOLATION=none` the merge is skipped and the order is otherwise the
  same.
- **Merged record.** One write records an item as merged. It sets the item's `commit`, clears its
  merge-in-flight record, clears the `dispatched_worktree`, `dispatched_branch` and `dispatched_base`
  fields (#3677) unless the worktree was left on disk, and records HEAD. For a v2 batch this write
  replaces `merge-wave.md`'s separate `quick-batch update` that clears those three fields, so no state
  exists in which the fields are cleared but the item is not yet marked merged. `commit` holds one
  value:
  - **Isolated:** the `--no-ff` merge commit that brought the item's branch in.
  - **`ISOLATION=none`:** the item's newest commit as the evaluation-scope resolver returns it (D3).

  `quick-batch complete` must later be called with that same commit. Hooks never use it to find the
  item's work (D3). A `pending` item with the merged mark is never re-dispatched or re-merged, and a
  resume continues it at its first scheduled entry without a sticky outcome.
- **What triggers the merged record.**
  - **`ISOLATION=none`:** the executor's return with its `SUMMARY.md` on disk. Execution there is
    sequential, so no merge step runs and no merge-in-flight record exists.
  - **Isolated:** the routing of each `worktree.cleanup-wave` entry, by the rules below. It never
    keys on `merged_removed` alone.
- **Merges are not replayed; an interrupted merge is resolved by ancestry.** Merge cleanup removes
  the worktree and deletes the branch, so a merge cannot be re-run. The durable worktree records keep
  the worktree path, the branch name and the base SHA, never the branch tip. A crash inside
  `worktree.cleanup-wave`, before its result is routed, can therefore leave merged work with no merged
  record. That window exists in v1.21.0 too, and schema 2 closes it for every batch:
  - **Before the call.** One write records each entry of the call as merge-in-flight, with the
    commit SHA of its branch tip. The record stays set until the write that resolves the entry lands.
  - **Checkout first.** Before resolving anything, the coordinator checks the checkout, both after
    the call and on resume. If a merge is in progress (`MERGE_HEAD` exists) or changes are staged, the
    in-flight records stay as they are. Resume refuses with a recoverable diagnostic that names the
    item and asks the user to finish or abort the merge. It never aborts, resets or commits that state
    itself, and no hook runs until the checkout is clean.
  - **Resolving an entry.** An entry is resolved by ancestry, with the same rule after the call and on
    resume, whatever status `worktree.cleanup-wave` returned or whether it returned at all:
    - **Merged.** The recorded tip is reachable from HEAD. The merge commit is the commit on HEAD's
      first-parent history whose second parent is the tip, and the merged record stores it as
      `commit`.
    - **No-op merge.** The tip was already reachable from the HEAD recorded in the merge-in-flight
      write (the executor added no commits, so `git merge` reported "Already up to date"). The item is
      merged, and `commit` is the recorded tip.
    - **Landed some other way.** The tip is reachable now, was not reachable from the recorded HEAD,
      and no such merge commit exists. Resume refuses with a recoverable diagnostic, and core never
      guesses a `commit`.
    - **Not merged, branch intact.** The tip is not reachable, and the branch still exists at the
      recorded tip. Cleanup deletes the branch only after the merge, so nothing was lost. The entry's
      reported status decides the routing:
      - A reported failure (a `blocked` entry) goes through the existing `merge_failed` routing (or
        `scope_violation`, as today).
      - Without such a status (the entry came back in `pending`, or the call never returned because
        of a crash), the entry was never attempted or its attempt left nothing behind. It goes back to
        waiting for a later merge round with its worktree intact, never to `merge_failed`.

      Either way, the same write clears its in-flight record.
    - **Not merged, branch gone.** The tip is not reachable and the branch no longer points at it.
      Resume refuses with a recoverable diagnostic that names the item and its recorded tip.
  - **What the reported status still decides.** It decides only what is reported and what stays on
    disk:
    - `merged_removed`: the item is merged and its worktree is gone.
    - `warning` with `branch_delete_failed`: the item is merged, its worktree is removed and its
      branch is left. The completion report names the branch.
    - `blocked` with `worktree_remove_failed`: the merge landed, so the item is merged. That reason
      is also returned when pruning an already-absent worktree fails, so it does not prove the
      worktree remains. The `dispatched_*` fields are kept, and the report names the worktree, only
      while its path still exists or is still registered. Otherwise they are cleared as for
      `merged_removed`.
    - Any other `blocked` reason: no reason code proves the merge did not land. `merge_timed_out`,
      for one, can follow a merge commit that landed while a hook was still running. The ancestry
      rule decides. A reachable tip makes the item merged. An unreachable tip routes it to
      `merge_failed` or `scope_violation` as today, with the worktree preserved.
    - Entries returned in `pending` after a mid-merge halt were never attempted. While the checkout
      is mid-merge their in-flight records stay, as above. Once it is clean they are resolved by
      ancestry like any entry. An entry that is not merged has its branch intact and goes back to
      waiting for a later merge round.
  - **Hooks.** An item's hooks start only once it is recorded as merged. An item flagged
    `merge_failed` was never merged, so the ancestry rule cannot later flip it.
- **The verifier is a ledger entry.** With `--validate`, the per-item ledger also holds the
  verifier's status, in its existing vocabulary (`passed`, `gaps_found` or `human_needed`,
  `VerifierStatus`), for every v2 batch. It is written when the verifier returns, and resume re-runs
  the verifier only when no status is recorded. That closes the second v1.21.0 crash window, a crash
  between the verifier's return and its routing. `verify:post` follows only `passed` (D2), and
  `gaps_found` goes through the existing `fail` routing (`quick-batch-dispatch.cts`).
  - **Which recorded statuses are final.** `passed` and `gaps_found` are. A recorded `human_needed` is
    not: it records that the verifier ran, and the verdict stays with the report. Like v1.21.0, every
    resume re-reads the item's `VERIFICATION.md` through `verification.status` without re-running the
    verifier. Once a person resolves the review in the report and the query returns `passed`, that
    status is recorded and the item continues at `verify:post`. While it returns `human_needed`, the
    item stays held. Any other value takes the existing `fail` routing.
- **Completion requires the ledger.** `quick-batch complete` refuses an item, and does not append its
  STATE row, while any scheduled step or gate lacks a sticky outcome or, with `--validate`, the item
  has no `passed` verdict. The STATE row therefore exists
  only once the ledger is complete. For a v2 batch, `resumeBatch`'s crash-window shortcut (STATE row
  present, so complete) also checks the ledger. If the ledger is incomplete despite a row, which can
  only happen through a hand edit, the item stays `pending` and its missing hooks run.
- **A held item.** A `blocked` gate leaves its item `pending` and merged, with the ledger recording
  `blocked`. The rest of the batch continues, and the completion report lists held items with the
  gate's message. The item's dependents stay ineligible, because eligibility needs every dependency
  `complete`. They are not marked `blocked`, so they become eligible on the resume that completes the
  held item. Once the user fixes the cause, `--resume` re-evaluates the `blocked` gate and continues
  from there. Sticky outcomes are never replayed, and there is no retry policy beyond `onError`.

**HEAD across resume.** `resumeBatch` refuses a HEAD other than the batch's `base_revision` when it
is given `--current-base-revision` and `base_revision` is non-null (`src/quick-batch.cts`).
`resume-mode.md` always passes the current HEAD. `base_revision` is HEAD at creation and is never
advanced. The batch's own merges already move HEAD, so a resume after any merged wave is refused
([#6203](https://github.com/open-gsd/gsd-core/issues/6203)). Hook commits,
the final artifact commit (`quick-batch/steps/completion.md`), executor commits under
`ISOLATION=none` and a user's commits that fix a held item's gate would all add to that. Requiring
HEAD to equal a recorded value cannot work. For a v2 batch the rule is ancestry, not equality:

- **Recorded HEAD.** Every ledger write (merge-in-flight and merged records, hook outcome, verifier
  status) also records the HEAD
  at that moment, in the same `withPlanningLock` write. Until the first such write, `base_revision`
  is the last recorded HEAD.
- **Accepted HEADs.** Resume accepts any HEAD that is the last recorded HEAD or descends from it. The
  commits after it are not attributed to anyone. The batch reconciles from its ledger, never from
  which commits exist. Merges keep their own per-entry `--expected-base` check.
- **Refused HEADs.** A HEAD that does not descend from the last recorded HEAD (a reset, a rebase, or a
  switch to another branch) is refused with the recoverable diagnostic
  [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) requires. This is the "diverged in a way the
  coordinator cannot reconcile" case of ADR-1239, and the batch's merged base keeps moving forward as
  that ADR states.
- **Crash window.** A crash between a hook's side effect (a commit, say) and its checkpoint leaves
  HEAD ahead of the last recorded HEAD. That HEAD is accepted, and the hook re-runs because it has no
  outcome. This is why annotated hooks must be idempotent.

Because every batch a core with increment 3 writes is schema 2, the rule covers every batch such a
core resumes. A v1 batch is checked against its `base_revision` under the same ancestry rule before
the first write upgrades it. Increment 3 therefore also fixes #6203. If #6203 lands earlier on its
own, its fix adopts this ancestry rule, and increment 3 builds on it.

**Further rules.**

- **No exactly-once guarantee.** A crash between a hook's side effect and its checkpoint re-runs that
  hook. Annotated steps and gates must be idempotent, and the capability how-to
  (`docs/how-to/develop-a-capability.md`) says so.
- **Planning invocations.** Planners for an invocation spawn only after every `plan:pre` step and
  gate of that invocation has a sticky outcome. A `blocked` gate holds the invocation and its items
  unplanned. Resume re-evaluates it like any `blocked` gate.
  - **When an item counts as planned.** An item is planned for an invocation only once its
    `quick-batch update` (`depends_on`, `files_modified`, recomputed waves;
    `quick-batch/steps/planner-wave.md` step 8) has persisted. A `PLAN.md` on disk is not enough.
  - **Plans that survived.** An item whose `PLAN.md` survived a crash but whose update did not persist
    is not planned. Resume re-runs the plan checker (with `--validate`) and the update for it from that
    `PLAN.md`, under the same invocation, without spawning a planner and without running its hooks
    again. Until then it is never dispatched for execution.
  - **Items still unplanned.** Items of invocation N with no `PLAN.md` are planned under a new
    invocation N+1 with only those items, and its `plan:pre` steps and gates run again. This is
    accepted under the idempotency rule.
  - **Orphaned outcomes.** Invocation N's outcomes stay valid for its items that were planned, and
    count toward nothing else. An invocation is complete when every item in its membership is planned
    or has moved to a later invocation.
  - **A crash during N's hooks.** If no planner of N spawned, N is not superseded. Resume continues
    N at its first ledger entry without a sticky outcome, which includes a `blocked` gate.
- **Batches started before the upgrade** carry `schema_version: 1` and no frozen schedule. Their
  first write upgrades them to 2 with an empty schedule, so their hooks keep v1.21.0 dispatch.
  Completed items stay complete as [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) requires,
  and no annotated hook runs retroactively for any of their items. They do gain the recovery records:
  the merge-in-flight and merged records, the verifier status and the recorded HEAD. The hook contract
  applies from the next batch.

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

Three increments, each its own PR.

**The compatibility test comes first.** It is the first commit of increment 1's PR and passes on
its own against unchanged `next`, before any other commit of that PR. It asserts that an unannotated manifest
dispatches exactly as v1.21.0 on every quick and quick-batch path and flag set. Increments 2 and 3
merge only with it green on their own head, and it stays in the suite afterwards.

1. **The field and `/gsd-quick` `execute:post`.**
   - Schema and validation: the D1 shapes, the unsupported-point error, the floor check and the
     machine-readable cell table.
   - Context filtering in `loop render-hooks`: `--context quick` and `--context quick-legacy`. Every
     legacy quick call site moves to `--context quick-legacy`.
   - A new `/gsd-quick` `plan:pre` dispatch for annotated hooks: steps and gates before the planner
     spawns, contributions into `planner`. It sits next to the legacy contribution injection, which
     keeps serving unannotated hooks.
   - The D3 contract, including `<quick_id>-TASK.json`.
   - An `execute:post` dispatch for annotated hooks that runs whatever the flags.
   - The logical `quick` host and its coverage check for `plan:pre` and `execute:post`.
   - The `resume <slug>` re-entry at the annotated `execute:post` dispatch (D2).
   - Tests: besides the compatibility test,
     - an annotated `execute:post` step under `--full` runs exactly once and never with `--phase`;
     - a `["phase"]` hook never runs in quick;
     - an isolated run dispatches `execute:post` only after a successful merge-back;
     - `resume <slug>` after an `execute:post` gate stop re-evaluates the gate without re-spawning the
       executor.
2. **`verify:*` and `discuss:*` in `/gsd-quick`.** Dispatch in the two step files, contribution
   targets `verifier` and `orchestrator`, coverage extended to them.
3. **quick-batch.**
   - The logical `quick-batch` host.
   - Per-invocation `plan:pre`, and per-item `execute:post` and `verify:*`.
   - `BATCH.json` schema 2 for every batch, with the loader change, the frozen schedule, the ledger,
     the merge-in-flight and merged records, the verifier status and the recorded-HEAD rule.
   - The D4 lifecycle in `quick-batch complete`, merge routing and completion recovery.
   - Tests:
     - a v2 round trip through every writer that preserves all v2 fields;
     - a v1 batch that is upgraded on resume, keeps v1.21.0 hook dispatch and resumes after a merged
       wave (#6203);
     - a crash inside `worktree.cleanup-wave` resolved by ancestry, for each status in the D4 routing
       list;
     - a crash between the verifier's return and its routing;
     - a recorded `human_needed` that passes once its report is resolved.

Each increment adds its D2 cells, with their first supported version, to the cell table, so a
manifest's `engines.gsd` floor can name the version that supports everything it annotates.

Each increment updates `references/loop-hook-dispatch.md`, the capability how-to and tutorial, the
quick-task how-to, the CLI surface manifest where the CLI changes, and carries an `Added` changeset.

## Consequences

- **Positive.** A capability can declare that it understands quick tasks and get a defined set of
  points, kinds and arguments there. Authors can read what quick does instead of reverse-engineering
  the workflows. The generator catches a quick call site that drifts from the matrix.
- **Neutral for existing manifests.** Unannotated hooks keep v1.21.0 behavior, gaps included. The
  legacy quick dispatch stays until a future ADR decides to retire it; this ADR does not.
- **Negative.** Two dispatch paths coexist in quick (legacy for unannotated hooks, the contract for
  annotated ones), and every render call site has to name its context. The matrix is one more thing to
  keep in step with the workflows. quick-batch recovery gains state, and every batch moves to schema
  2, so an older core cannot resume a batch started or touched by a newer one. Annotated hooks carry an
  idempotency obligation.

## Alternatives considered

1. **Dispatch every active hook in quick.** Rejected: phase-bound work (refactor-trigger, the tdd
   gate, research, drift) would run on every quick task with an empty or inherited `--phase`.
2. **Only move quick's `execute:post` dispatch out of the code-review step.** Rejected for the same
   reason, and it leaves `verify:*`, `discuss:*` and quick-batch undefined.
3. **A core allow-list of capability ids allowed in quick.** Rejected: permanent maintenance of
   third-party capabilities in core.
4. **A host-aware `when`.** Rejected. [ADR-894](894-capability-declaration-format.md) keeps `when`
   config-only and deterministic: the same config gives the same activation everywhere. A host-aware
   `when` would make activation depend on invocation state, so it would extend the predicate model, and
   writing invocation state into config is unsafe with concurrent tasks. `executionContexts` leaves
   activation alone. It is a static declaration in the manifest that the host reads to decide which of
   its own call sites schedule an already-active hook. Self-gating stays the rule for unannotated
   hooks; the field only replaces it where self-gating cannot work, because the hook is never
   dispatched or cannot tell it is in a quick task (Context).
5. **A core matrix without a per-hook field.** Rejected: it says what quick can host, not whether a
   given hook understands quick tasks.
6. **Default unannotated hooks into the new contract.** Rejected: it changes existing manifests'
   behavior without their authors' consent (Hyrum's law), which is what D1 exists to prevent.
7. **quick-batch runs `/gsd-quick` per item.** Rejected: it creates a second shared-state writer,
   which [ADR-1239](1239-gsd-embeddable-orchestration-engine.md)'s quick-batch binding forbids.

## Open questions

- **Names.** `executionContexts` is the working name of the field. The CLI flags (`--quick`,
  `--quick-modes`, `--quick-batch`, `--planning`) and the render contexts (`quick`, `quick-legacy`)
  are contract surface too. All of them should be settled before increment 1 merges, since each one is
  a stability contract.
- **`fast`.** `/gsd-fast` runs inline with no hooks at all. Whether it becomes a third context is left
  to a later issue.
