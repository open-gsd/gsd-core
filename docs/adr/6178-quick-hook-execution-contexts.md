# ADR-6178: Execution contexts — quick tasks become an opt-in host for capability hooks

- **Status:** Proposed
- **Date:** 2026-11-13
- **Issue:** [#6178](https://github.com/open-gsd/gsd-core/issues/6178) (`approved-feature`, go-with-conditions: this ADR before code, three increments, compatibility test first)
- **Amends:** [ADR-857](857-capability-system.md) (the hook model gains an execution-context dimension next to point and kind) · [ADR-894](894-capability-declaration-format.md): the hook entry schema gains `executionContexts`, a generated quick-host contract sits beside the Loop Host Contract (D5), and the hook-activation paragraph and its own #1022 clarification section ("Runtime/mode context … is likewise **not** a hook-activation concern … It **self-gates inside the skill**") gains an exception: the execution context is applied by the host before dispatch, for annotated hooks only (D1)
- **Builds on:** [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (quick-batch binding: single-writer coordinator, `BATCH.json` as the source of truth for completion) · [ADR-1244](1244-capability-ecosystem.md) (`engines.gsd` as the compatibility gate for manifests that use the field)
- **Split out (separately proposed, each awaiting its own approval):** #6530 (`/gsd-quick` resume and re-entry), #6531 (quick-batch recovery records), #6532 (quick-batch stored modes). Increments are tracked in #6533, #6534 and #6535.

## Context

[ADR-857](857-capability-system.md) defines capability hooks along two dimensions: a **point** (one of
the Loop Extension Points: ADR-857 names 12, #3997 added `review:pre`, and the generator's canonical
set is the 13, `scripts/gen-loop-host-contract.cjs:68-82`) and a **kind** (step, contribution, gate).
[ADR-894](894-capability-declaration-format.md) makes the hosts publish which points they expose, and
the generator checks hooks against that contract. Both were written for the phase loop. Neither says
what a hook does when the work is a quick task.

In v1.21.0 the quick paths answer that question by accident:

| Path | What is dispatched |
|---|---|
| `/gsd-quick` | `plan:pre` planner contributions only (`quick.md`, per #3778). `execute:post` steps only in full mode, because the generic dispatch (#3606) sits inside Step 6.25 *Code review*, which is skipped unless `$FULL_MODE` is true (`quick.md:577-583`). `execute:post` gates never. No `discuss:*` with `--discuss`, no `verify:*` with `--validate`. |
| `/gsd-quick-batch` | `plan:pre` planner contributions only (`quick-batch/steps/planner-wave.md:24-32`). Nothing else. |

Three consequences:

1. **A capability cannot finish work it started in a quick task.** Its planner contribution reaches
   the quick planner, but its `execute:post` step runs only when the user also asked for full mode.
   The motivating case is the community capability gsd-musk-simplification, which this ADR's author
   wrote and maintains outside this repository: its contribution has the planner record entries
   under `.planning/musk/`, and its `execute:post` step `musk commit` is the step that commits them.
   In a plain `/gsd-quick` that step is never dispatched, so nothing commits the entries.
2. **Hooks have no quick invocation contract.** Command steps run as `gsd_run <command> --phase
   "${PHASE_NUMBER}" --raw` (`gsd-core/references/loop-hook-dispatch.md:76`), and `quick.md` never
   sets `PHASE_NUMBER`. A step gets an empty or an inherited phase, and nothing tells it which quick
   task it runs for.
3. **The generator sees one quick seam only.** `validateHooksWired`
   (`gsd-core/bin/lib/capability-validator.cjs:3866`) checks that *some* file in `HOST_LOOP_FILES`
   covers each point and kind, as a union across hosts. The one per-file check for quick is the
   `plan:pre` contribution into `planner`: `scripts/gen-loop-host-contract.cjs:36-38` registers
   `quick.md` as an `auxiliaryHosts` entry of `plan-phase.md` for it. Nothing checks quick's other
   points. Its narrowed `execute:post` passes because `verify-phase-goal.md` covers the kinds
   (`:49-51`), and `quick-batch/**` is not scanned at all.

**Dispatching every active hook in quick is not the fix.** Moving the `execute:post` dispatch out of
the code-review step would run the bundled refactor-trigger step (`refactor evaluate --phase N`,
which writes `.planning/phases/<N>/<NN>-REFACTOR.md`) on every plain quick task once
`refactor.trigger_enabled` is on. With an empty phase the command rejects the call; with a phase
inherited from the session it evaluates the wrong phase and writes into it. Research, drift and the
tdd gate are phase-sized too. Whether a hook makes sense in a quick task is a property of the hook,
not of the point.

**Self-gating inside the hook is not the fix either.** [ADR-894](894-capability-declaration-format.md)
keeps `when` config-only and lets a skill no-op when its context does not apply. That works when the
hook is dispatched and can tell where it is. Here neither holds reliably: quick does not dispatch most
points, and there is no structured quick contract. Planner contributions do land in a prompt that names
the quick directory, description and planning mode, but only as prose around them; command steps get
`--phase` and nothing that identifies the quick task.

**In short.** A hook declares the execution contexts it understands (`executionContexts`, D1). An
unannotated hook keeps its v1.21.0 quick behavior exactly. A hook that lists `"quick"` is dispatched
by both quick hosts at a fixed set of cells (D2) and receives the quick task's identity instead of a
phase (D3). quick-batch dispatches those hooks from its coordinator against a hook set frozen when the
batch starts, with per-hook outcomes so a resume never replays a finished hook (D4). The quick hosts
get their own generated contract, checked per host (D5). The `/gsd-quick` resume contract, the
quick-batch recovery records and the stored batch modes are not decided here: they are #6530, #6531 and #6532,
and the increments that need them wait for them.

## Decision

### D1 — A third dimension: execution context

A hook entry (step, contribution or gate) gains an optional field:

```jsonc
// abbreviated: the other keys a step requires (`produces`, `consumes`) are omitted
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
`<quick_id>-TASK.json` to be written (D3), and it is not part of a batch's frozen hook set (D4).

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
and every quick call site says which one it is. `--context` is a **new value flag** of
`loop.render-hooks`, as are `--quick` and `--quick-modes` (D3): today its value flags are
`active-cap`, `after-fingerprint`, `config-dir` and `runtime` only (`src/cli-surface.cts:242-249`).
Increment 1 adds the three to that entry, with the same `eqFlags`, `nonEmptyFlags` and `trimEqFlags`
treatment.

| Render | Called from | Returns |
|---|---|---|
| `loop render-hooks <point>` (no `--context`) | phase hosts, unchanged | hooks with the field absent or listing `"phase"` |
| `loop render-hooks <point> --context quick-legacy` | the v1.21.0 `/gsd-quick` call sites (`quick.md:303` `plan:pre` and `:583` Step 6.25 `execute:post`), and from increment 3 one of the two literal calls at the quick-batch legacy `plan:pre` site (`quick-batch/steps/planner-wave.md:27`), taken for every batch not marked as started before increment 3 (below) | unannotated hooks only |
| `loop render-hooks plan:pre --context quick-batch-legacy` | `quick-batch/steps/planner-wave.md:27` in increments 1 and 2, and from increment 3 the other literal call at that site, taken only for a batch started before increment 3 (transitional, below) | hooks with the field absent or listing `"quick"`; never a `["phase"]` hook |
| `loop render-hooks <point> --context quick --quick <id> --quick-modes <set>` | the new `/gsd-quick` D2 call sites | hooks listing `"quick"` only, plus the quick context (D3) |

Any other `--context` value is refused. `--quick` and `--quick-modes` are accepted only with
`--context quick` and are required there. Increment 1 moves both legacy `/gsd-quick` call sites to
`--context quick-legacy` and the quick-batch one to `--context quick-batch-legacy`. So in
`/gsd-quick` an annotated hook runs only through its D2 call site, and a `["phase"]` hook never runs
on either quick path.

**Decision: quick-batch keeps delivering annotated `plan:pre` contributions until increment 3.**
v1.21.0 injects every active `plan:pre` contribution into `planner` into each quick-batch planner
prompt (`quick-batch/steps/planner-wave.md:24-32`), and quick-batch's own `plan:pre` cell arrives
only in increment 3. Had increment 1 moved that site to `quick-legacy`, a hook whose author adds
`"quick"` to its field would stop reaching quick-batch planners in increments 1 and 2. The
transitional `quick-batch-legacy` render prevents that. The site's dispatch text stays as it is, so
it injects the annotated contributions exactly as v1.21.0 does, without a `<quick_context>` block,
and still runs no `plan:pre` step or gate. From increment 3 the site renders `quick-legacy`, next to
its new per-invocation dispatch, for every batch not marked as started before increment 3. A batch
started before increment 3 keeps `quick-batch-legacy`, so its planners keep receiving what they
received when it started (D4). `references/loop-hook-dispatch.md` documents the value as
core-internal, for that one site. The alternative, a validation error for an annotated `plan:pre`
contribution until increment 3, cannot be limited to quick-batch: validation is per shape and
`"quick"` covers both hosts (D2), so it would also refuse the `/gsd-quick` contribution that
increment 1 exists to deliver.

**From increment 3 the site picks its context with a branch, never a variable.** `planner-wave.md`
step 3 holds two literal calls, `loop render-hooks plan:pre --context quick-legacy --raw` and `loop
render-hooks plan:pre --context quick-batch-legacy --raw`, and runs exactly one of them per planning
invocation. The branch reads `legacy_hooks` (working name), a boolean in the result of `quick-batch
planning-start` (#6535), the call that persists the invocation before its hooks run (D4). It reports
the batch's stored mark (D4): `true` exactly for a batch started before increment 3, `false`
otherwise. An empty frozen hook set alone never sets it, since a batch created when no annotated
hook existed has one too. A result without a boolean `legacy_hooks` is a coordinator error: the step
stops the batch with a diagnostic and renders neither context. Both calls are legacy calls outside
every `gsd:quick-cell` region, so D5's marker rules apply to them unchanged (D5). Passing the
context in a variable is rejected as Alternative 10.

**The filter sits in the resolver.** `loop render-hooks` is not the only reader of active hooks:
`resolveActiveHooksForPoint` (`src/loop-resolver.cts:517`) also has in-process callers, the
`verify:post` audit in `src/phase.cts:6713` and a handler in `gsd-core/bin/gsd-tools.cjs:2011`. So
the context filter is an option of `resolveActiveHooksForPoint` itself. Its default is the phase
context (field absent or listing `"phase"`), so every existing caller, in-process or through render,
keeps phase-only results and never sees a `["quick"]` hook. The render's `--context` passes the
option through.

An unannotated hook keeping its legacy quick dispatch is deliberate. Existing bundled and third-party
manifests rely on today's behavior (planner contributions in quick, `execute:post` steps under
`--full`). Changing what they do without their authors opting in is the break this ADR avoids.

A manifest that uses the field declares an `engines.gsd` floor at the first version that supports
**every quick cell (point × host) it relies on**, not just the version that introduced the field.
Two mechanisms close the gap:

- **Older hosts.** Hosts older than the field ignore it: today's `validateStep`,
  `validateContribution` and `validateGate` (`gsd-core/bin/lib/capability-validator.cjs:2968`,
  `:3064`, `:3104`) do not reject unknown keys on typed entries, and the render does not read it.
  Such a host keeps its legacy dispatch, which is safe but not what the author asked for. The
  `engines.gsd` floor is what turns that into an install-time error under
  [ADR-1244](1244-capability-ecosystem.md) instead of a silent difference; the ignored key alone
  guarantees nothing.
- **Hosts that know the field** validate each annotated hook by its **shape**: its point, its kind
  and, for a contribution, its `into` target. They check the floor against the machine-readable cell
  table (D2), which is keyed by host and shape:
  - An annotated hook whose shape no quick host supports in the running version is a validation
    error, never a silent no-op. That covers an unsupported point (`plan:post`, or `review:pre`,
    which no quick path reaches), an unsupported kind at a supported point (a contribution at
    `execute:post`) and an unsupported target (`into: verifier` or `into: code-reviewer`, which the
    phase loop delivers but no quick cell does). Such a hook stays valid for the phase loop once
    `"quick"` is removed from its field.
  - A floor below the first version in which *any* quick host supports an annotated shape is a
    validation error.
  - A floor below a cell on one particular host (quick-batch `execute:post` before increment 3, say)
    is a validation warning. An older host skips that cell by design (D2).

### D2 — The quick support matrix

Core owns one matrix of what the quick hosts dispatch for annotated hooks. C = contribution, S = step,
G = gate.

| Point | `/gsd-quick` | `/gsd-quick-batch` |
|---|---|---|
| `plan:pre` | Always. S and G before the planner spawns; C into `planner`. | Per planning invocation (D3, D4), in `planner-wave.md` step 3 next to the legacy dispatch, from increment 3. Until then C into `planner` keeps its v1.21.0 delivery through the transitional render (D1). |
| `execute:post` | After every successful Step 6 executor run, **whatever the flags**: for an isolated run after the Step 6 merge-back succeeded, otherwise right after the executor returns. Always before Step 6.25. No dispatch when the executor or the merge-back fails. S and G. | Per item, serially in manifest order, once the item is recorded as merged (#6531's merged record, D4), before verification and `quick-batch complete`: in `merge-wave.md` after step 5 routes the `worktree.cleanup-wave` result, and with `ISOLATION=none` in `worktree-dispatch.md` step 4, once that step has found the item's `SUMMARY.md` after every item of the round returned. So with `ISOLATION=none` an item's `execute:post` runs after the later items of its round have executed, not right after its own executor; per-item hooks assume nothing about their peers (D3). |
| `verify:pre` | With `--validate`, before the verifier, in `quick/steps/quick-verification.md`. S and G; C into `orchestrator`. | Per item, with `--validate`, in `verification-wave.md`. |
| `verify:post` | With `--validate`, after the verifier, **only when its status is `passed`**. S and G. | Same condition, per item, in `verification-wave.md`. |
| `discuss:pre` / `discuss:post` | With `--discuss`, in `quick/steps/discussion-phase.md`. S and G; C into `orchestrator` at `discuss:pre`. | Not applicable (`--discuss` is rejected). |
| `plan:post`, `execute:pre`, `execute:wave:*`, `ship:*`, `review:pre` | Not supported. | Not supported. |

**Quick contributions exist at three points, and the verify and discuss ones go to the
orchestrator.** In quick a contribution is valid only at `plan:pre` (into `planner`), `verify:pre`
and `discuss:pre` (into `orchestrator`). A contribution at `verify:post` or `discuss:post` is a
validation error in quick, even into `orchestrator`, which the phase loop admits there: nothing
follows those points in quick for its text to shape. `workflows/verify-work.md:4` publishes the
verify points with `agent-roles: orchestrator`, and
[ADR-894](894-capability-declaration-format.md) keeps the `verify` step orchestrator-only. The quick
hosts follow that rule and amend nothing. A `verify:pre` contribution is injected into the quick
orchestrator's own context where its step file starts (`quick/steps/quick-verification.md`,
`quick-batch/steps/verification-wave.md`), before the verifier spawns. It never reaches the
`gsd-verifier` prompt. The `discuss:pre` contribution follows the same rule in
`quick/steps/discussion-phase.md`.

**One `verify:post` condition for both hosts.** `verify:post` runs only after a `passed` verdict.
After `gaps_found`, `human_needed` or a status the query could not resolve, each host keeps its
v1.21.0 routing, and no `verify:post` runs. In `/gsd-quick` that routing is the offer to re-run the
executor or accept on `gaps_found` (`quick/steps/quick-verification.md:52`), and continuing on
`human_needed` (`:51`). In quick-batch it is the item's `fail` or `human_needed` route
(`src/quick-batch-dispatch.cts:225-226`). Accepting a result as-is never counts as `passed`.

**The cell table is data, not prose.** A cell is a host and a shape (point, kind and, for a
contribution, target), the unit D1 validates. Which cells exist is not hand-authored: it is the
generated quick-host contract (D5), read from markers at the quick call sites, as
[ADR-894](894-capability-declaration-format.md) §3 requires of host contracts. The only
hand-authored data is each cell's first supported version and its gating mode, in one
machine-readable table in core that the validator reads (D1). A parity test fails when the version
table names a cell the generated contract lacks, or the contract has a cell with no version.
Increment 1 also has `scripts/gen-loop-host-contract.cjs` write the quick matrix in
`references/loop-hook-dispatch.md` between generated-region markers, from the contract and the
version table. Its `--check`, already part of `lint:generated-sync`, then catches a hand edit or a
stale region, so the documented and the enforced matrix cannot drift.

The `"quick"` context covers both hosts; a manifest does not pick one. Validation and dispatch
therefore work at different granularities:

- **Validation is per shape.** Annotating a hook for `"quick"` with a shape that *no* quick host
  supports in the running version is a manifest validation error: a point such as `plan:post`,
  `execute:pre` or `review:pre`, `verify:*` before increment 2 or 3 (whichever lands first) adds a
  `verify:*` cell, a contribution at `execute:post`, `verify:post` or `discuss:post`, or a
  contribution into any target other than `planner` at `plan:pre` and `orchestrator` at `verify:pre`
  and `discuss:pre`.
- **Dispatch is per cell.** Each host dispatches an annotated hook only at the cells it supports. A
  cell that does not apply to a host (`discuss:*` in quick-batch) is permanently skipped there. A cell
  not yet delivered (quick-batch `execute:post` before increment 3) is skipped too, exactly as v1.21.0
  skips it. The one shape v1.21.0 already delivers on a host before its cell arrives, a quick-batch
  `plan:pre` contribution into `planner`, keeps that delivery until increment 3 (D1).
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
names the gate, its message, the task directory and the commits left behind, and says the task was
not recorded. A gate at `plan:pre`, `discuss:*` or `verify:*` stops at that point in the same way,
with whatever that point has already produced left in place. The stop report does not offer
`/gsd-quick resume <slug>`: a resumed run dispatches no annotated hook until #6530 lands (below), so it
would continue past the gate without re-evaluating it.

**A resumed `/gsd-quick` dispatches no annotated hook until #6530.** As of 2026-11-26, on `next`,
`resume <slug>` runs `query init.quick` with no slug (`commands/gsd/quick.md:163-166`), which
computes a fresh quick id from the clock, so the resumed run does not hold the task's own id. Giving
hooks that id, re-evaluating a gate that stopped the task, and re-entering at the stopped point are
the resume contract, which #6530 proposes. The rule below keys on one signal: the `resume` key in
the result of the workflow's Step 2 `init.quick` (`gsd-core/workflows/quick.md:129`). #6530 item 1
specifies the `--resume <slug>` flag of that query, whose result carries the task's own `quick_id`,
`slug` and `task_dir` plus a `resume` object; a fresh run's result has no `resume` key. Two changes
make a resumed run's Step 2 call it: the RESUME subcommand calls `init.quick --resume` (#6530 item
3) and hands the workflow `RESUME_SLUG`, and Step 2 then runs `query init.quick --resume
"$RESUME_SLUG"` in place of `init.quick "$DESCRIPTION"`. #6530 item 3 names only the first;
increment 1 requires both (PR #6652 makes both). The rest of #6530 (`TASK.json` schema 2 and the
re-entry) waits for this ADR and increment 1. Until it lands, a run whose Step 2 `init.quick` result
carries the `resume` key skips every D2 call site and the `quick-tasks-task-json` call (D3), and
keeps its v1.21.0 path, including the `--context quick-legacy` dispatch for unannotated hooks. The
rule reads whether the key is present, not the fields inside it, so it needs the key present on
every resumed run and absent, not `null`, on every fresh one. Core sets it; a process test of `query
init.quick` pins its presence with `--resume` and its absence without; and each D2 call site's guard
on it is a text contract (D3). Increment 1 relies on it, so it merges only after the flag and the
Step 2 change are on `next` (Delivery).

**The `gaps_found` re-run.** Today `quick/steps/quick-verification.md:52` defines only the menu line
("Re-run executor to fix gaps"), not what the re-run does. Increment 1 defines it as Step 6 again,
under the same isolation as the first run: an isolated re-run spawns a new executor worktree and
merges it back as Step 6 does. Its success has the same definition as the first run's: the executor
returned success and, when isolated, its merge-back succeeded. The annotated `execute:post` dispatch
then runs again, and the verifier runs again, with the annotated `verify:*` hooks around it (from
increment 2) and `verify:post` only after `passed`. Whether Step 6.25 runs again is unchanged. Each
pass through a point dispatches that point's annotated hooks again, which the idempotency rule (D4)
makes safe. #6530 adds the record that lets a resume tell a finished re-run from an interrupted one.

Built-in code review is not part of the matrix. It stays a full-mode specialization of `/gsd-quick`,
runs once, and quick-batch gains none.

### D3 — The quick invocation contract

Annotated hooks dispatched at a D2 call site receive quick context instead of phase context. The one
other way an annotated hook reaches a quick path, the transitional `quick-batch-legacy` delivery of
`plan:pre` contributions (D1), is v1.21.0's injection and carries no `<quick_context>` block.

**Command steps and query gates** get these arguments instead of `--phase`, all validated before
they are passed. A quick id is never passed as a phase number.

| Dispatch | Arguments |
|---|---|
| `/gsd-quick` task | `--quick "<quick_id>" --quick-modes "<set>"` |
| quick-batch item (`execute:post`, `verify:*`) | `--quick "<quick_id>" --quick-batch "<batch_id>" --quick-modes "<set>"` |
| quick-batch planning invocation (`plan:pre`) | `--quick-batch "<batch_id>" --planning "<invocation_id>" --quick-modes "<set>"` |

In quick-batch `<set>` is the batch's modes as #6532 stores them at `create`, the same for every item
and invocation of the batch. A planning invocation's command step gets no `--quick` and no list of
items: it reads the invocation's membership from `BATCH.json` through the read-only
`quick-batch planning-members` verb keyed by those two ids (#6535).

**Skill steps, agent steps, gates and contributions** receive one **quick context** object:

```jsonc
{ "quick_id", "task_dir", "task_file", "cwd", "modes": [...], "batch_id", "planning", "items" }
```

- For a `/gsd-quick` task or a batch item, `quick_id` and `task_dir` name the task
  (`<planning_root>/quick/<quick_id>-<slug>/`, the workstream-aware planning directory that `query
  init.quick` resolves), `planning` and `items` are `null`, and `batch_id` is `null` outside a batch.
- For a batch planning invocation, `quick_id`, `task_dir` and `task_file` are `null`, `planning` is
  the invocation id, and `items` lists its members as `[{ "quick_id", "task_dir", "task_file" }]`.
- `task_file` is the path of the task's `<quick_id>-TASK.json` when that file exists, else `null`
  (below).
- `modes` is the resolved mode set as a JSON array.

A skill step gets the object's JSON as the `args` string of its `Skill(...)` call. An agent step gets
it as a `<quick_context>` block at the start of its prompt. Contributions get one `<quick_context>`
block per target prompt, in front of the injected fragments. Query gates take the command-step
arguments. The values come from core, never from user text (the description is not in it), and
nothing is passed through the environment.

**Who builds it.** Core builds the object from its own state; no workflow assembles it by hand.

- **In `/gsd-quick`, the render.** `loop render-hooks <point> --context quick --quick <id>
  --quick-modes <set>` returns it under a new envelope key, **`quickContext`**, next to today's
  `point`, `activeHooks`, `rendered` and optional `warnings` and `skippedHooks`
  (`src/loop-resolver.cts:748-767`). The envelope key is camelCase like its neighbors; the object's
  own keys are the snake_case hook contract above.
  - **No annotated hook at that point.** When no active hook listing `"quick"` exists at the point,
    the render returns today's empty envelope (`activeHooks: []`, `rendered: "_No active hooks at
    <point>._"`, `src/loop-resolver.cts:372-374`) with `quickContext: null`, and exits 0. It reads no
    task file and looks up no directory, so a task with no annotated hook, which has no `TASK.json`,
    gets a defined result at every D2 call site.
  - **Otherwise** it validates the id (`^\d{6}-[0-9a-z]{3}$`) and the mode set (grammar below),
    finds the one directory `<planning_root>/quick/<quick_id>-*/`, and sets `task_file` from whether
    `<quick_id>-TASK.json` exists there. It never reads `TASK.json`. No matching directory, or more
    than one, is a render error with a diagnostic; the `/gsd-quick` call site then stops the task
    as a halting gate would (D2), because hooks that cannot be given their task must not run blind.
- **In quick-batch, the coordinator.** Dispatch never goes through render (D4), so
  `quick-batch due-hooks` (#6535) builds it from `BATCH.json`, the stored modes (#6532) and the item's or
  the invocation's membership, and returns it as `quickContext` next to the due entries.

**Resolved modes** are the set of `discuss`, `research` and `validate` after quick's flag
normalization (`quick.md:33-39`), so `--full` and the three granular flags yield the same set. Raw
arguments are never passed. On a command line the set is written comma-separated, in the fixed order
`discuss,research,validate`, with no spaces and no duplicates, and the empty set is the literal
`none`: `^(none|discuss(,research)?(,validate)?|research(,validate)?|validate)$`. In the quick
context object it is a JSON array in the same order, and the empty set is `[]`.

**The task description never goes on a command line.** It is free user text. Hooks read it from
`<quick_id>-TASK.json` in the task directory, which keeps the dispatch contract's rule that command
arguments are validated, not interpolated:

- **Schema 1:** `{ "schema_version": 1, "quick_id", "slug", "batch_id" (or null), "description",
  "description_truncated" }`. `slug` is the task directory's slug, so
  `<planning_root>/quick/<quick_id>-<slug>/` names the directory without a lookup. No field changes
  after the write. The file holds no modes and no execution record; #6530 proposes a schema 2 that adds
  them, and its readers keep accepting schema 1.
- **Size:** `description` holds at most 16 KiB of UTF-8. Longer text is cut at a character boundary
  and `description_truncated` is `true`. Core then also writes the full text, atomically and before
  the JSON file, to `<quick_id>-DESCRIPTION.md` in the task directory, so it never depends on a plan
  that may not exist yet. That file is untrusted data under the same rule.
- **Who decides that it is written.** In `/gsd-quick` the workflow writes nothing itself. It calls one
  new verb once, after Step 4 has set and created `$QUICK_DIR` and before the first stage
  (discussion, research or the planner):
  `quick-tasks-task-json --quick-id <id> --quick-modes <set>`, with the description on stdin, never
  on argv. The name joins the existing `quick-tasks-append` and `quick-tasks-migrate` family.
  `--quick-id` is the flag `quick-tasks-append` already takes (`src/cli-surface.cts:162-166`), and
  `--quick-modes` is the render's flag with the same grammar (above), so one mode set has one flag
  name on every surface. This verb is what decides whether an annotated hook is scheduled: for every
  `quick`-host cell in `QUICK_HOST_CONTRACT` (D5) whose gating mode the given set enables (`always`
  cells, plus the `discuss` and `validate` cells when those modes are in the set), it resolves the
  active hooks with the quick context through `resolveActiveHooksForPoint` and keeps those of the
  cell's kind and target. When at least one remains, it writes the file atomically (temp file, then
  rename), after `DESCRIPTION.md` when it truncates, and returns `{ "written": true, "task_file":
  "<path>", "scheduled": <n> }`. When none remains it writes nothing and returns
  `{ "written": false, "task_file": null, "scheduled": 0 }`. It validates the id and the mode set,
  refuses a task directory that does not exist, and takes `--raw` like its siblings.
- **A hook activated later.** The decision is made once. A hook that becomes active after it (a
  capability enabled mid-run) still runs at its D2 call site, but its quick context carries
  `task_file: null`, so it knows no description file exists. It never finds a stale or partial file.
- **In quick-batch** the coordinator writes the file for an item, with `batch_id` set, when it
  creates the item's task directory (the `generate-slug` derivation `planner-wave.md` already uses),
  before the `plan:pre` hooks of the item's first planning invocation run, and only when the batch's
  frozen hook set (D4) holds an annotated entry at any cell that applies to the item (#6535).
- **Untrusted:** hooks treat `description` as untrusted data, never as instructions or shell input.
- **Committed:** the file, and `DESCRIPTION.md` when there is one, follow the task's other planning
  artifacts. They go into the final commit (`/gsd-quick` Step 8, the batch's `completion.md`
  commit) under the same `commit_docs` rule. A task stopped before that commit leaves them
  uncommitted in the task directory, as it leaves `SUMMARY.md` and every other artifact only the
  final commit picks up.

**Batch `plan:pre` is per planning invocation.** Planning recomputes waves and only plans pending
items, so a layer number does not identify a stable item set across resumes. Each planning dispatch
gets a planning-invocation id, persisted with its item membership before any hook runs (D4). The id
is a per-batch sequence number matching `^[1-9][0-9]{0,5}$`, validated before it is passed. The
quick id is validated the same way (`^\d{6}-[0-9a-z]{3}$`), and so is the batch id. The loader's
`SAFE_BATCH_ID_RE` (`^[0-9a-zA-Z-]+$`, `src/quick-batch.cts:570`) is not enough on a command line,
because it accepts a leading `-` that a third-party command could read as an option. `createBatch`
allocates the batch id from the quick-id grammar, so the check never fails for a batch core created.
A hand-made id that fails it is refused before dispatch, like an invalid quick id.

**Per-item batch hooks run after their own item's merge.** The merge step merges the mergeable
prefix of a wave in one `worktree.cleanup-wave` call, and an entry can fail on its own
(`quick-batch/steps/merge-wave.md:67-83`). A per-item `execute:post` runs only for an item recorded
as merged, after that call returns. That record, and the rule that resolves an interrupted merge,
are #6531's. Wave peers may or may not be present in the checkout: those merged in the same call are,
later or failed ones are not. A hook must assume neither.

**A hook finds its task's work through the evaluation-scope resolver.** That resolver is
`check evaluation-scope --quick "<quick_id>"`, [ADR-5057](5057-one-owner-per-workflow-verdict.md) §4,
the one `/gsd-quick` Step 6.25 already uses (`quick.md:602`). It returns the commits on the current
branch whose message contains the quick id (a fixed-string `git log --grep`,
`src/gate-evaluation-scope.cts:1258`). A hook never derives a commit range, a `BATCH.json` commit or
the working-tree diff on its own. In core, `scripts/lint-evaluation-scope-drift.cjs` already fails CI
on such derivations in the gate modules, workflows and agents it scans (its shapes S1 to S5,
including a shell `git log --grep`). A third-party hook is outside that scan, so for it this is the
contract, not a check.

- **What makes the id appear.** Today only `/gsd-quick`'s own commits are sure to name it: the
  pre-dispatch artifact commit of an isolated run (`docs(<quick_id>): …`,
  `quick/steps/worktree-pre-dispatch-commit.md:42-45`) and the final commit
  (`docs(quick-<quick_id>): …`, `quick.md:738`). The executor prompts say only "commit each task
  atomically" (`quick.md:527`, `quick-batch/steps/worktree-dispatch.md:114`), and the isolated merge
  commit is `chore: merge executor worktree (<branch>)` (`src/worktree-safety.cts:1502`).
  Increment 1 (for `/gsd-quick`) and increment 3 (for quick-batch) add one rule to each executor
  prompt: every commit subject names the task as `<type>(quick-<quick_id>): …`, the form Step 8
  already uses. `gsd-executor` writes `{type}({phase}-{plan}): …` (`agents/gsd-executor.md:548`,
  `:566`), so the rule does not add a second format. The quick prompts hand the executor
  `quick-<quick_id>` as the value it puts in that scope, in place of `{phase}-{plan}`, and the
  agent's own format is unchanged.
- **How the rule is checked.** The repository bans tests that read source as text
  (`eslint-rules/no-source-grep.cjs`). The prompt rule is therefore a text contract in
  `scripts/static-checks/text-contracts/`, run by `scripts/run-static-checks.cjs` in `lint:ci`
  ([ADR-6315](6315-ci-redesign.md) Part 3): it asserts the rule's text in the executor prompt of
  `quick.md` Step 6 (and, from increment 3, `worktree-dispatch.md` step 3). Its behavior is a
  process test that makes commits in that form in a fixture repository and checks that `check
  evaluation-scope --quick <id>` resolves them.
- **When the resolver finds nothing.** An executor is an agent and can miss the rule, so the contract
  does not rest on it. A `resolved` result with no commits to evaluate means nothing to evaluate,
  never a failure, whatever its reason: `no-matching-commits` (no commit names the task),
  `merge-only` (only merge commits do) or `empty-after-exclusions` (the matched commits touch only
  excluded paths) (`src/gate-evaluation-scope.cts:1311-1312`). An `unresolvable` result (exit 69,
  which `quick.md:603` already tolerates) is an error of that hook: a step gets `error` and the host
  continues, and a gate follows its `onError`.
- **The list is capped.** The resolver returns at most `--max-commits` commits (default 200, ceiling
  1,000, `clampMaxCommits`, `src/gate-evaluation-scope.cts:150`, `:1067-1068`) and does not say when
  it cut the list. A quick task stays far below that. A hook that must see every commit asks for the
  ceiling, and treats a list at the cap as possibly incomplete. Core's own records never depend on
  the resolver (#6531's merged record stores a commit it reads from git directly).

An annotated hook accepts this contract. That is the meaning of listing `"quick"`.

### D4 — quick-batch dispatches through the coordinator, from a frozen hook set

quick-batch dispatches hooks from its coordinator through the same shared primitives, never by
running `/gsd-quick` per item. [ADR-1239](1239-gsd-embeddable-orchestration-engine.md)'s single-writer
ownership of `BATCH.json`, STATE.md and worktree merges is unchanged. This section decides what a
hook can rely on in a batch. It relies on two separate proposals, #6531 and #6532, and on the storage
spec in #6535, the tracker that implements increment 3 once #6531 and #6532 have merged:

- **#6531, recovery records:** the merged record that tells the coordinator an item's work is in the
  checkout, the rule that resolves an interrupted merge by ancestry, the persisted verifier status,
  and a `head_revision` that resume checks by ancestry, so a hook's own commit does not make the
  batch unresumable. It introduces `BATCH.json` schema 2.
- **#6532, stored modes:** the batch's modes, stored at `create` and used on every `--resume`, so which
  cells apply to an item and the modes hooks receive cannot change mid-batch.
- **#6535, storage and verbs:** the field layout, the size limits and the coordinator verbs below,
  under `BATCH.json` schema 3, a version a core without increment 3 refuses as an unknown schema, so
  it can never drop or ignore hook state.

**The frozen hook set.**

- **When it is frozen.** The hooks are resolved once, when the batch starts. The set records every
  annotated hook at a cell quick-batch supports, active or not, so a capability enabled, disabled or
  upgraded mid-batch does not change a running batch. Each planning invocation is persisted (id,
  item membership, the identities of the `plan:pre` entries it schedules) before its hooks run.
- **What an entry stores.** Each entry is a snapshot: the full resolved manifest entry (`ref`,
  `onError`, `blocking`, `produces`/`consumes`, the field itself), the capability id and version, and
  the activation evaluated at freeze (enabled, `when`, `pointFrom`). Activation is evaluated at freeze,
  never at dispatch.
- **How a hook is identified.** Identity is capability id, point, kind, the entry's index in its typed
  manifest array (`steps`, `contributions` or `gates`; not the lifecycle `hooks`), and a SHA-256 of
  the entry. The hash input is defined here, because core has no canonical serializer: the UTF-8
  bytes of `JSON.stringify` applied to the manifest entry as resolved, after every object in it has
  had its keys sorted recursively in the default `Array.prototype.sort` order (UTF-16 code units),
  arrays left in order, with no indentation. Increment 3 adds that key-sorting step beside the
  schedule writer; it changes no other serialization. Two entries from one capability at one point
  stay distinct. Every outcome carries the full identity, and one that matches no snapshot entry
  makes the batch fail closed as a corrupt manifest
  ([ADR-1239](1239-gsd-embeddable-orchestration-engine.md)).
- **Dispatch never re-reads the manifest.** A frozen batch dispatches from its snapshot; the live
  manifest is not read again. A snapshot whose `ref` no longer resolves (command, skill or agent
  removed) counts as an error of that hook. A step gets `error` and the host continues. A gate
  follows its `onError`: `error-skipped` under `skip`, `held` under `halt`.
- **What is scheduled.** For an item or a planning invocation, the scheduled hooks are every frozen
  entry at the cells that apply to it under the batch's stored modes (#6532), active or not. An entry
  whose activation was false at freeze is recorded `skipped`, and that outcome is sticky: for an
  item when the set is frozen, for a planning invocation's `plan:pre` entries when the invocation
  is created (its id does not exist before). Activation itself is never re-evaluated.
- **Contributions are snapshots, not checkpoints.** A contribution is prompt content, not a side
  effect. Its resolved fragment is stored with the frozen set and injected into every spawn of the
  target agent, including replacement and revision spawns after a resume. It is never marked done.
- **It is bounded.** The frozen set and its outcomes live in `BATCH.json`, which `loadBatch` parses
  with a 1,048,576-character cap (`src/quick-batch.cts:725`). #6535 sets caps at freeze and a guard at
  every write so a batch never outgrows that cap through its own writes, and `create` refuses a batch
  whose worst case would.

**Outcomes.** Steps and gates are checkpointed: per-item hooks by item, point and hook identity;
`plan:pre` hooks by planning invocation, point and hook identity. Each outcome is written by the
coordinator under `withPlanningLock`.

| Outcome | Kind | Meaning | On resume |
|---|---|---|---|
| `ok` | step | ran | sticky |
| `skipped` | step or gate | not run: activation false at freeze (`when` false, capability inactive, `pointFrom` not matched); written at freeze | sticky |
| `error` | step | errored and was skipped with a warning (per [ADR-894](894-capability-declaration-format.md) a step never halts), including an unresolvable `ref` | sticky |
| `passed` | gate | passed | sticky |
| `rejected` | gate | a non-blocking gate failed | sticky |
| `error-skipped` | gate | errored under `onError: skip`, including an unresolvable `ref`; no verdict | sticky |
| `held` | gate | a blocking gate failed, or the gate errored under `onError: halt` (an unresolvable `ref` included) | **re-evaluated**: the gate runs again |

`held` is the only outcome that is not sticky. Every other outcome is final for its item or
invocation and is never replayed.

**The item lifecycle.** `QuickBatchItemStatus` keeps its four values (`pending`, `complete`,
`failed`, `blocked`); no status is added.

- **Per-item order.** The item merges. Then, in manifest order among the items that merged:
  `execute:post` hooks, then with `--validate` `verify:pre`, the verifier and `verify:post`, then
  `quick-batch complete`. With `ISOLATION=none` the merge is skipped and the order is otherwise the
  same. An item's hooks start only once #6531 records it as merged; an item routed to `merge_failed`
  was never merged and runs none.
- **Completion requires the outcomes.** `quick-batch complete` refuses an item, and does not append
  its STATE row, while any scheduled step or gate of it lacks a sticky outcome. The STATE row
  therefore exists only once its hooks are done. The verifier condition on completion is #6532's (it
  needs the stored modes) on top of #6531's verifier status.
- **A held item.** A `held` gate leaves its item `pending` and merged, with its outcome recorded as
  `held`. The rest of the batch continues, and the completion report lists held items with the
  gate's message. The item's dependents stay ineligible, because eligibility needs every dependency
  `complete`. They are not marked `blocked`, so they become eligible on the resume that completes
  the held item. Once the user fixes the cause, `--resume` re-evaluates the `held` gate and
  continues from there. Sticky outcomes are never replayed, and there is no retry policy beyond
  `onError`.

**Planning invocations.** Planners for an invocation spawn only after every `plan:pre` step and gate
of that invocation has a sticky outcome. A `held` gate holds the invocation and its items unplanned,
and resume re-evaluates it like any `held` gate. When an item counts as planned is #6531's rule (a
persisted per-item `planned` mark, set by the `quick-batch update` that records its plan, not the
presence of a `PLAN.md`). On that basis:

- **Items still unplanned.** Items of invocation N that are not planned and have no `PLAN.md` are
  planned under a new invocation N+1 with only those items, and its `plan:pre` steps and gates run
  again. This is accepted under the idempotency rule.
- **Plans that survived.** An item whose `PLAN.md` survived a crash but that is not planned is
  finished under the same invocation from that `PLAN.md` (#6531), without spawning a planner and without
  running its `plan:pre` hooks again.
- **Orphaned outcomes.** Invocation N's outcomes stay valid for its items that were planned, and
  count toward nothing else. An invocation is complete when every item in its membership is planned
  or has moved to a later invocation.
- **A crash during N's hooks.** If no planner of N spawned, N is not superseded. Resume continues N
  at its first scheduled entry without a sticky outcome, which includes a `held` gate.

**No exactly-once guarantee.** A crash between a hook's side effect and its checkpoint re-runs that
hook. Annotated steps and gates must be idempotent, and the capability how-to
(`docs/how-to/develop-a-capability.md`) says so. A hook that commits moves HEAD before its outcome is
recorded; #6531's ancestry rule is what lets the batch resume from that HEAD.

**Batches started before increment 3** have no frozen hook set. The first write a core with
increment 3 makes to one gives it an empty set and marks it as started before increment 3: a
schema-3 boolean, `legacy_hooks` (working name, #6535 item 1), that this write alone sets to `true`
and that `create` writes as `false`. So its hooks keep v1.21.0 dispatch: `planning-start` reports
`legacy_hooks: true`, so the legacy `plan:pre` site takes its literal `--context quick-batch-legacy`
call (D1), completed items stay complete as [ADR-1239](1239-gsd-embeddable-orchestration-engine.md)
requires, and no annotated hook runs retroactively for any of its items, finished or not (Departure
14). The hook contract applies from the next batch.

### D5 — Logical hosts and per-host coverage

**Logical hosts** are a workflow together with its step files: `quick` (`quick.md`,
`quick/steps/**`) and `quick-batch` (`quick-batch.md`, `quick-batch/**`). For them, the generator
checks every point, kind and contribution target that D2 claims, per host and not as a union, and the
gating mode each cell declares. What the generator cannot see is covered by the checks named under
"The gating mode is declared and checked" below.

**A separate generated contract, beside the Loop Host Contract.** The Loop Host Contract
([ADR-894](894-capability-declaration-format.md) §3) cannot hold them. In
`scripts/gen-loop-host-contract.cjs`, `assertPointsCoverage` (`:341`) requires each entry to declare
exactly its step's points and refuses a point declared twice, and `parseLoopHostBlock` (`:157`)
allows one marker per file and recognizes the keys `step`, `points`, `agent-roles`, `produces` and
`consumes` only, with no key for a kind, a target or a cell. Its consumers read one entry per point:
`loop-resolver.cts` concatenates the points, and the validator's `POINT_TO_CONTRACT`
(`gsd-core/bin/lib/capability-validator.cjs:73-76`) keeps the last entry for each. A quick entry
would fail the generator, or replace the phase entry for its points. So the quick hosts get their
own contract, and the existing one is left as it is:

- **The marker.** Each quick call site carries `<!-- gsd:quick-cell host=<quick|quick-batch>
  point=<point> kinds=<kinds> [into=<target>] mode=<always|discuss|validate> -->` markers next to
  its dispatch call, any number per file. A marker has one of two forms. A **step/gate marker** lists
  `step`, `gate` or both and has no `into`. A **contribution marker** lists `contribution` alone
  and always has `into`. A call site that dispatches all three kinds, such as the `/gsd-quick`
  `plan:pre` site (S and G, C into `planner`), carries one marker of each form, the way the
  existing generator already registers `execute:post` in `verify-phase-goal.md` as two
  `auxiliaryHosts` entries, `step`/`gate` without a target and `contribution` into `verifier`
  (`scripts/gen-loop-host-contract.cjs:49-51`). A marker with an unknown host, point, kind or
  target, `contribution` listed beside another kind, a contribution marker without `into`, or a
  step/gate marker with `into` fails generation.
- **The check is bound to the call.** Consecutive markers form a group that governs the next
  dispatch call: `loop render-hooks <point> --context quick` in a `quick` host file, and
  `quick-batch due-hooks … --point <point>` in a `quick-batch` host file, since batch dispatch reads
  the frozen hook set instead of rendering (D4). The group's region runs from its first marker to the
  earliest of: the next dispatch call after its own call (`loop render-hooks` of any context, or
  `quick-batch due-hooks` for any point), the next marker group, or the section end.
- **The section end is found outside code fences.** It is the next Markdown ATX heading of any level,
  `<step` or `</step>` tag, or `gsd:section` open or close marker, counted only on lines outside
  fenced code blocks. The fences are found with the markdown-sectionizer seam's `scanFencedBlocks`
  (`src/markdown-sectionizer.cts:359`, [ADR-1372](1372-markdown-sectionizer-seam.md)), so a
  shell `# …` comment inside a fence (`quick.md:170-172`, say) or a banner such as `### GSD ► QUICK
  TASK` inside a fence (`quick.md:68`) never ends a region. Dispatch calls and dispatch text inside
  fences still count, because the calls themselves sit in `bash` fences. `quick.md` already uses
  `gsd:section` markers, so a region never crosses one.
- **What the region must hold.** In that region the generator requires exactly one dispatch call for
  the marker's point, and after that call the dispatch text for each listed kind and target. A legacy
  call next to it therefore ends the region before its own dispatch text. Today's `scanWiredPoints`
  (`:632`) and `scanWiredKinds` (`:740`) aggregate by point over a whole file and ignore
  `--context`, so a legacy `--context quick-legacy` dispatch in the same file could stand in for a
  missing annotated one. The quick check therefore scans only the marker's region and counts only
  quick dispatch calls. `--context quick` matches only as a whole token (`--context quick` or
  `--context=quick` followed by whitespace or the end of the line), so `--context quick-legacy`
  never counts. Each marker is checked on its own with the existing `coveredKindsInRegion(region,
  expectedInto)` (`:679`), and the two forms are what make that function's rules hold. A
  contribution marker passes its `into` as `expectedInto`: a segment then credits a kind only when
  it also names `into == "<target>"` (`:717-720`), which the contribution dispatch text does. A
  step/gate marker passes no `expectedInto`, so its `kind == "step"` and `kind == "gate"` dispatch
  text needs no `into`, a deferral to `loop-hook-dispatch.md` credits the kinds it names or, naming
  none, every kind (`:713`), and a segment that narrows by `into ==` (the contribution line) credits
  nothing for it (`:720`). A D2 cell has at most one target per point, so a call site needs at most
  one contribution marker, and a call that served two targets would carry one per target. A quick
  dispatch call in a quick host's files outside any marker's region fails generation too.
- **Every `--context` is a literal.** The generator reads a call's context from its text, so in a
  quick host's files a `loop render-hooks` call with no `--context`, or with a value other than the
  literal `quick`, `quick-legacy` or `quick-batch-legacy` (a shell variable such as
  `"$LEGACY_CONTEXT"`, say), fails generation. A call site that needs two contexts carries two
  literal calls under a workflow branch, as the quick-batch legacy `plan:pre` site does from increment
  3 (D1). Both of its calls are legacy calls: neither needs a marker, and each ends a region that
  reaches it, like any other dispatch call.
- **The gating mode is declared and checked.** The marker carries `mode=<always|discuss|validate>`,
  the flag D2 gates the cell on. The generator checks it against the version table's entry for the
  cell, which records the same mode, and checks that the marker sits in the step file D2 names for it
  (`quick/steps/quick-verification.md` for the `validate` cells, say). That is a declared-placement
  check: it catches a cell moved to another file or relabeled. Two further checks, each in a harness
  the repository already has, cover how the mode reaches that file:
  - **Section loading** (process tests in the style of `tests/section-manifest-init-facts.test.cjs`,
    which drive the real CLI): `query init.quick` with and without `--discuss` and `--validate`,
    and with `--full` (folded into the three flags at `src/init.cts:1894-1896`), and
    `query init.quick-batch` with and without `--validate`, include the `gsd:section` that loads the
    cell's step file in `section_manifest.included` only when the mode is set.
  - **The step file's own guard** (a text contract, as above): each gated step file keeps its
    first-line skip guard (`quick/steps/discussion-phase.md:3`, `quick/steps/quick-verification.md:3`,
    `quick-batch/steps/verification-wave.md:3`), and `quick.md` keeps its flag normalization
    (`:33-39`).

  None of these proves that the agent executing the workflow obeys the loaded text at run time; no
  check in the repository can (Departure 9).
- **The export.** The generated module exports a second array, `QUICK_HOST_CONTRACT`, as `[{ host,
  cells: [{ point, kind, into, mode, file }] }]`. `serializeContract` (`:512`) in the generator
  writes it and adds it to the module's `module.exports`. `LOOP_HOST_CONTRACT`, the five-step
  assertions, `loop-resolver.cts` and `POINT_TO_CONTRACT` stay unchanged, and none of them reads the
  new array.
- **Its readers.** The D1 shape validation, the version-table parity test (D2) and
  `quick-tasks-task-json` (D3) read `QUICK_HOST_CONTRACT`.
- **Where the version table lives.** `gsd-core/bin/lib/capability-validator.cjs` is a committed
  plain `.cjs` that requires the generated contract module, so that it works before `npm run
  build:lib`. The version table is another committed, hand-authored plain `.cjs` beside it,
  `gsd-core/bin/lib/quick-cell-versions.cjs` (working name). It requires nothing, so the validator
  and the generator can both read it with no build step and no cycle.
- **The legacy seam.** The `auxiliaryHosts` entry that registers `quick.md` for the legacy
  `plan:pre` contribution into `planner` stays, but its check changes. Today it scans the whole file
  with `scanWiredPoints` and `scanWiredKinds`, which take no context, so the new `--context quick`
  dispatch in the same file would satisfy it and mask a deleted legacy one. The entry gains
  `context: 'quick-legacy'`. For such an entry the generator scans the file with every
  `gsd:quick-cell` region removed and counts only `--context quick-legacy` calls. The `quick` host's
  own `plan:pre` cells are declared by markers at the new call site.

The version table (D2) holds only each cell's first supported version and gating mode, and the
parity test keeps it and `QUICK_HOST_CONTRACT` in step.

`produces`/`consumes` is checked per logical host, against the points that host actually schedules
and the modes that gate them, not per context. Both hosts share the `"quick"` context but schedule
different points: a `discuss:post` producer can satisfy a consumer in `quick`, never in
`quick-batch`. Today's validator pools producers globally
(`gsd-core/bin/lib/capability-validator.cjs`); the quick hosts get their own pools. The phase pool
changes too: it takes only hooks that run in the phase loop (field absent or listing `"phase"`). So
a `["quick"]` producer never satisfies a phase consumer. A consumer whose producer only runs under
an optional mode must degrade gracefully when it did not run, as
[ADR-894](894-capability-declaration-format.md) already requires of self-gated producers.

The phase hosts keep the existing union check. Converting them to per-host coverage is out of scope.

## Delivery

Three increments, each its own PR, each tracked by its own issue, which needs its own approval before
code. They merge in this order:

- **Increment 1** after `query init.quick --resume` and the workflow's Step 2 call of it on a
  resumed run are on `next` (#6530's first part; PR #6652 implements both), because the `resume`
  key that call returns is the signal of the resume rule (D2).
- **Increment 2** after increment 1. It uses the field, the render contexts, the version table and
  the quick host contract that increment 1 adds.
- **Increment 3** after increment 1, #6531 and #6532. It does not wait for increment 2.

**The compatibility test comes first.** It is the first commit of increment 1's PR and passes on its
own against unchanged `next`, before any other commit of that PR. It asserts that an unannotated
manifest dispatches exactly as v1.21.0 on every quick and quick-batch path and flag set, `resume
<slug>` included. Increments 2 and 3 merge only with it green on their own head, and it stays in the
suite afterwards.

1. **The field and `/gsd-quick` `plan:pre` and `execute:post`** (#6533).
   - Schema and validation: the D1 field shapes, the unsupported-shape error (point, kind and
     contribution target), the floor check, the version table and its parity test against the
     generated contract.
   - Context filtering in `resolveActiveHooksForPoint` and `loop render-hooks`: `--context quick` and
     `--context quick-legacy`, with `--quick` and `--quick-modes`, and the `quickContext` envelope
     key. Both legacy `/gsd-quick` call sites move to `--context quick-legacy`, and
     `planner-wave.md:27` moves to the transitional `--context quick-batch-legacy` (D1).
   - A new `/gsd-quick` `plan:pre` dispatch for annotated hooks: steps and gates before the planner
     spawns, contributions into `planner`. It sits next to the legacy contribution injection, which
     keeps serving unannotated hooks.
   - An `execute:post` dispatch for annotated hooks that runs whatever the flags, and the `gaps_found`
     re-run as Step 6 again (D2).
   - The D3 contract: the command-step arguments, the quick context object, the `--quick-modes`
     grammar, `<quick_id>-TASK.json` schema 1 and `DESCRIPTION.md`, the `quick-tasks-task-json` verb,
     and the commit-subject rule in the `quick.md` executor prompt with its text contract.
   - The rule that a run whose `init.quick` result carries `resume` skips every D2 call site and
     the `quick-tasks-task-json` call, with a text contract on each call site's guard (D2).
   - The logical `quick` host (D5): the `gsd:quick-cell` marker, its fence-aware check and the
     `QUICK_HOST_CONTRACT` export in `scripts/gen-loop-host-contract.cjs`, with cells for `plan:pre`
     and `execute:post`. The same script writes the generated quick matrix region in
     `references/loop-hook-dispatch.md` (D2).
   - **CLI surface.** In `src/cli-surface.cts`, the `loop.render-hooks` entry (`:242-249`) gains the
     value flags `context`, `quick` and `quick-modes`, and `quick-tasks-task-json` is declared beside
     `quick-tasks-append` (`:162-166`) with the value flags `quick-id` and `quick-modes`. Both reach
     `docs/CLI-SURFACE-MANIFEST.json` by regenerating it with `scripts/gen-cli-surface-manifest.cjs`.
     `UNDECLARED_VERBS` does not grow.
   - Tests: besides the compatibility test,
     - an annotated `execute:post` step under `--full` runs exactly once and never with `--phase`;
     - a `["phase"]` hook never runs in quick;
     - an annotated `plan:pre` contribution into `planner` still reaches the quick-batch planner
       prompts through `--context quick-batch-legacy`, and a `["phase"]` one does not;
     - a run whose `init.quick` result carries `resume` dispatches no annotated hook and writes no
       `TASK.json`;
     - an isolated run dispatches `execute:post` only after a successful merge-back;
     - a render with `--context quick` at a point with no annotated hook returns the empty envelope
       with `quickContext: null` and reads no file, also for a task with no task directory;
     - `quick-tasks-task-json` writes nothing and returns `written: false` when no `quick`-host cell
       enabled by the modes has an active annotated hook, and writes the file when one has;
     - a hook given a `no-matching-commits` scope treats it as nothing to evaluate;
     - an annotated contribution at `execute:post`, or one `into: verifier`, is a validation error;
     - a `["quick"]` hook is absent from `resolveActiveHooksForPoint`'s default (phase) result, so
       the in-process `verify:post` audit never sees it;
     - the legacy `auxiliaryHosts` check fails when the `--context quick-legacy` dispatch is removed
       while the `--context quick` one stays;
     - a `gsd:quick-cell` region is not ended by a `#` line inside a code fence;
     - the commit-subject behavior test in a fixture repository (D3);
     - installed-overlay composition: an annotated hook that reaches the hosts through an installed
       overlay is scheduled and validated exactly as one in the base manifest, since overlays use
       the same canonical builder (the issue's test list).
2. **`verify:*` and `discuss:*` in `/gsd-quick`** (#6534). Dispatch in
   `quick/steps/quick-verification.md` and `quick/steps/discussion-phase.md`, contribution target
   `orchestrator` only, coverage extended to them, the section-loading process tests and the guard
   text contracts for `--discuss`, `--validate` and `--full` (D5).
3. **quick-batch** (#6535; after increment 1, #6531 and #6532).
   - The logical `quick-batch` host, with the section-loading test for `init.quick-batch --validate`.
   - Per-invocation `plan:pre` in `planner-wave.md` step 3. The legacy site there holds two literal
     calls, `--context quick-legacy` and `--context quick-batch-legacy`, and a branch on the
     `legacy_hooks` field of `planning-start`'s result takes the second only for a batch started
     before increment 3 (D1, D4, D5). A coordinator test pins `legacy_hooks: true` for a batch
     upgraded from v1 or v2 and `false` for one `create` wrote, an empty hook set included, and a
     text contract asserts the two literal calls and the branch on that field. Per-item
     `execute:post` in `merge-wave.md` after step 5, and with `ISOLATION=none` in
     `worktree-dispatch.md`. Per-item `verify:*` in `verification-wave.md`. The completion check in
     `completion.md`. Resume of hook outcomes in `resume-mode.md`.
   - The frozen hook set, the outcomes and the planning invocations (D4) under `BATCH.json` schema 3,
     with the storage layout, the size limits and the coordinator verbs #6535 specifies, and the
     commit-subject rule in the `worktree-dispatch.md` executor prompt.
   - Not in this increment: `batch-init.md` passing `--options`, `init.quick-batch --resume` and the
     `quick-batch.md` mode variables are #6532's delivery; the merge, verifier and HEAD records are
     #6531's.

Each increment adds its D2 cells, with their first supported version, to the cell table, so a
manifest's `engines.gsd` floor can name the version that supports everything it annotates.

Each increment updates `references/loop-hook-dispatch.md`, the capability how-to and tutorial, the
quick-task how-to, the CLI surface manifest where the CLI changes, and `CONTEXT.md`, and carries an
`Added` changeset. In `CONTEXT.md`, increment 1 amends `RULESET.CAPABILITY.cutover-self-gating` and
`RULESET.CAPABILITY.step-additive-gate-blocks` with D1's exception (for an annotated hook the host
applies the execution context before dispatch; self-gating stays the rule for unannotated hooks) and
adds the terms it introduces: `executionContexts`, annotated hook, the quick context object and
logical host. Increment 3 adds the frozen hook set and the hook outcomes. `CONTEXT.md` changes with
the code that makes it true, not in this ADR's PR.

## Consequences

- **Positive.** A capability can declare that it understands quick tasks and get a defined set of
  points, kinds and arguments there. Authors can read what quick does instead of reverse-engineering
  the workflows. The generator catches a quick call site that drifts from the matrix.
- **Neutral for existing manifests.** Unannotated hooks keep v1.21.0 behavior, gaps included. The
  legacy quick dispatch stays until a future ADR decides to retire it; this ADR does not.
- **Negative.** Two dispatch paths coexist in quick (legacy for unannotated hooks, the contract for
  annotated ones), and every quick render call site has to name its context. The matrix is one more
  thing to keep in step with the workflows. Annotated hooks carry an idempotency obligation. Until #6530
  lands, a resumed `/gsd-quick` runs no annotated hook, so a gate stop has no in-place retry. The
  quick-batch cells wait for #6531 and #6532, and increment 3's schema 3 means an older core cannot resume
  a batch a core with increment 3 has written. quick-batch needs one transitional render context,
  `quick-batch-legacy`, until increment 3 and afterwards for batches started before it (D1).
- **Departures.** Where this differs from the issue's proposal and acceptance criteria is listed in
  Departures from #6178, below.

## Departures from #6178

The issue's proposal and acceptance criteria differ from this ADR in these places. Each needs the
maintainer's acceptance:

1. **`verify:pre` contributions reach the orchestrator, not the verifier.** The issue's matrix sends
   them "into `verifier`", and its criterion says "contributions reach the verifier". D2 sends them
   to the quick orchestrator only, because `verify-work.md` declares the verify points
   `agent-roles: orchestrator` and [ADR-894](894-capability-declaration-format.md) keeps the verify
   step orchestrator-only. That criterion is not met as written.
2. **Batch `plan:pre` is per planning invocation, not per layer.** The issue gives hooks a layer id
   and `--layer <n>`. D3 uses a persisted invocation id and `--planning <n>`, because a layer number
   does not name a stable item set across resumes.
3. **`halted` became `held`, and a held item is not failed.** In the issue, `halted` leaves the item
   incomplete and goes through the existing failure routing. In D4 a `held` gate leaves its item
   `pending` and merged, outside the failure routing, and `--resume` re-evaluates the gate.
4. **More outcomes.** The issue records `ok`, `skipped`, `error` and `halted`. D4 records `ok`,
   `skipped` and `error` for steps, and `passed`, `rejected`, `error-skipped` and `held` for gates,
   so a gate's verdict is not folded into a step's.
5. **`produces`/`consumes` per logical host, not per context** (D5), because the two quick hosts
   share a context but not their points.
6. **The quick-batch increment depends on two separate proposals.** The issue's third increment
   holds quick-batch hooks alone. Here increment 3 waits for #6531 (recovery records) and #6532 (stored
   modes), and it moves batches to `BATCH.json` schema 3, which an older core refuses to resume. The
   issue's breaking-changes assessment says none.
7. **A resumed `/gsd-quick` runs no annotated hook until #6530.** The issue does not address resume.
   Its motivating case is met for a task that runs to completion in one pass, not for one stopped
   and resumed before #6530 lands. The rule keys on the `resume` key `init.quick --resume` returns
   (#6530's first part; PR #6652 implements it), so increment 1 also waits for that flag to be on
   `next`, which the issue's first increment does not.
8. **`verify:post` runs only after a `passed` verdict.** The issue's matrix runs it "after the
   verifier returns", and its criterion has no passed-only condition. D2 runs it only after
   `passed`, on both hosts, so a hook at `verify:post` never acts on a failed or unresolved
   verification. After `gaps_found` or `human_needed` the host's v1.21.0 routing applies instead.
9. **Coverage is enforced in part.** The issue asks the generator to enforce coverage of every
   annotated host, including that each gating flag reaches its call site. D5's generator checks the
   point, kinds and target at each marked call and the declared gating mode against the step file.
   That the flag reaches the call rests on two other checks: process tests of the section manifest
   `init.quick` and `init.quick-batch` build for each mode, and text contracts on each gated step
   file's skip guard. Together they prove the step file loads only under its mode and carries its
   guard. They do not prove the executing agent obeys it, so that part of the criterion is not met
   by any check.
10. **`plan:pre` for `/gsd-quick` lands in increment 1.** The issue's first increment holds the
    field, validation and `/gsd-quick` `execute:post`. Increment 1 here also adds the annotated
    `/gsd-quick` `plan:pre` dispatch, because the motivating capability needs its planner
    contribution and its `execute:post` step to opt in together.
11. **The `gaps_found` re-run is defined.** Today's workflow offers it without defining it. D2 makes
    it Step 6 again under the same isolation, followed by the annotated `execute:post` dispatch.
12. **`TASK.json` holds no modes, and only a task with a scheduled hook gets one.** The issue has core
    write "the description and the resolved modes" to `<quick_id>-TASK.json` before the first hook
    runs. D3's schema 1 holds the description and no modes: hooks get the modes as `--quick-modes`
    and in the quick context, and #6530's schema 2 adds them for resume. `quick-tasks-task-json`
    writes the file once, before the first stage, and only when an annotated hook is scheduled then,
    so a hook that becomes active later gets `task_file: null` instead of a file.
13. **With `ISOLATION=none`, a batch item's `execute:post` runs after its round, not right after its
    own executor.** The issue runs it "after successful execution" of the item. D2 runs it in
    `worktree-dispatch.md` step 4, which checks each item's `SUMMARY.md` only after every item of the
    round has returned, because that is where the coordinator first learns that the item succeeded.
    By then the later items of its round have executed too.
14. **A batch started before increment 3 never runs an annotated hook.** The issue's
    breaking-changes assessment says: "A batch started before the upgrade has none, and resume
    treats it as having no recorded outcomes." Read that way, a resumed batch would schedule the
    annotated hooks of its remaining items, none of them recorded yet. D4 instead gives such a batch
    an empty frozen hook set, marked as started before increment 3, so no annotated hook runs for
    any of its items, finished or not, and its hooks keep v1.21.0 dispatch, the transitional
    `quick-batch-legacy` `plan:pre` delivery included (D1). Resolving a hook set on resume would
    freeze it after the batch began, so a capability enabled in between would join a running batch,
    which D4's freeze-at-start rule forbids, and a batch created before #6532 has no stored modes to
    say which cells apply to its items. Annotated `plan:pre` contributions still reach its planners
    through that legacy delivery, as they did in v1.21.0; no annotated step or gate runs. The hook
    contract applies from the next batch.

Earlier revisions of this ADR also departed from the issue with frozen batch modes, schema 2 for
every batch, the HEAD ancestry rule, the "planned once the update persisted" rule and the re-read of
`human_needed` reports. Those moved with their pieces to #6531 and #6532, which state them as their own
proposals.

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
8. **Write `TASK.json` for every quick task.** Rejected: it would change the artifacts, and the final
   commit, of every quick task whether or not any hook asks for them. Only a task with an annotated
   hook scheduled gets the file (D3).
9. **Make an annotated `plan:pre` contribution a validation error until increment 3**, so quick-batch
   never silently drops one. Rejected: validation is per shape and `"quick"` covers both hosts, so the
   error would also refuse the `/gsd-quick` contribution increment 1 delivers. The transitional
   `quick-batch-legacy` render keeps the v1.21.0 delivery instead (D1).
10. **Pass the legacy context in a variable** at the quick-batch `plan:pre` site: one call,
    `--context "$LEGACY_CONTEXT"`, with the value taken from a coordinator field. Rejected: the
    generator and the text contracts read a call's context from its text (D5). A variable hides
    which context the call renders from the text contract that pins the site, and the generator's
    literal-`--context` rule for quick host files (D5) would need an exception for a value it cannot
    see. Two literal calls under a branch on `legacy_hooks` keep every context visible and D5's
    marker rules as they are (D1).

## Open questions

- **Names.** `executionContexts` is the working name of the field. The CLI flags (`--context`,
  `--quick`, `--quick-modes`, `--quick-batch`, `--planning`), the render contexts (`quick`,
  `quick-legacy`), the `quickContext` envelope key and the quick context object's keys, the
  `gsd:quick-cell` marker and the `QUICK_HOST_CONTRACT` export (D5), and the `quick-tasks-task-json`
  verb (D3) are contract surface too. `quick-batch-legacy` and the `legacy_hooks` mark, stored in
  `BATCH.json` and returned by `planning-start`, are the exceptions: they are core-internal and used
  only at the quick-batch legacy `plan:pre` site (`planner-wave.md:27`, D1). Each of the others
  should be settled before the increment that introduces it merges, since each one is a stability
  contract. The quick-batch verb names are #6535's.
- **`fast`.** `/gsd-fast` runs inline with no hooks at all. Whether it becomes a third context is left
  to a later issue.
