# ADR-6178: Execution contexts — quick tasks become an opt-in host for capability hooks

- **Status:** Proposed
- **Date:** 2026-11-13
- **Issue:** [#6178](https://github.com/open-gsd/gsd-core/issues/6178) (`approved-feature`, go-with-conditions: this ADR before code, three increments, compatibility test first)
- **Amends:** [ADR-857](857-capability-system.md) (the hook model gains an execution-context dimension next to point and kind) · [ADR-894](894-capability-declaration-format.md): the hook entry schema gains `executionContexts`, a generated quick-host contract sits beside the Loop Host Contract (D5), and the hook-activation paragraph and its own #1022 clarification section ("Runtime/mode context … is likewise **not** a hook-activation concern … It **self-gates inside the skill**") gains an exception: the execution context is applied by the host before dispatch, for annotated hooks only (D1)
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
   The motivating case is the community capability gsd-musk-simplification, which this ADR's author
   wrote and maintains outside this repository: its contribution has the planner record entries
   under `.planning/musk/`, and its `execute:post` step `musk commit` is the step that commits them.
   In a plain `/gsd-quick` that step is never dispatched, so nothing commits the entries.
2. **Hooks have no quick invocation contract.** Command steps run as
   `gsd_run <command> --phase "${PHASE_NUMBER}" --raw` (`references/loop-hook-dispatch.md`), and
   `quick.md` never sets `PHASE_NUMBER`. A step gets an empty or an inherited phase, and nothing
   tells it which quick task it runs for.
3. **The generator sees one quick seam only.** `validateHooksWired` checks that *some* file in
   `HOST_LOOP_FILES` covers each point and kind, as a union across hosts. The one per-file check for
   quick is the `plan:pre` contribution into `planner`: `scripts/gen-loop-host-contract.cjs` registers
   `quick.md` as an `auxiliaryHosts` entry of `plan-phase.md` for it. Nothing checks quick's other
   points. Its narrowed `execute:post` passes because `verify-phase-goal.md` covers the kinds, and
   `quick-batch/**` is not scanned at all.

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

**The filter sits in the resolver.** `loop render-hooks` is not the only reader of active hooks:
`resolveActiveHooksForPoint` (`src/loop-resolver.cts`) also has in-process callers, the
`verify:post` audit in `src/phase.cts` and a handler in `gsd-tools.cjs`. So the context filter is an
option of `resolveActiveHooksForPoint` itself. Its default is the phase context (field absent or
listing `"phase"`), so every existing caller, in-process or through render, keeps phase-only results
and never sees a `["quick"]` hook. The render's `--context` passes the option through.

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
- **Hosts that know the field** validate each annotated hook by its **shape**: its point, its kind
  and, for a contribution, its `into` target. They check the floor against the machine-readable cell
  table (D2), which is keyed by host and shape:
  - An annotated hook whose shape no quick host supports in the running version is a validation
    error, never a silent no-op. That covers an unsupported point (`plan:post`), an unsupported kind
    at a supported point (a contribution at `execute:post`) and an unsupported target (`into:
    verifier` or `into: code-reviewer`, which the phase loop delivers but no quick cell does). Such a
    hook stays valid for the phase loop once `"quick"` is removed from its field.
  - A floor below the first version in which *any* quick host supports an annotated shape is a
    validation error.
  - A floor below a cell on one particular host (quick-batch `execute:post` before increment 3, say)
    is a validation warning. An older host skips that cell by design (D2).

### D2 — The quick support matrix

Core owns one matrix of what the quick hosts dispatch for annotated hooks. C = contribution, S = step,
G = gate.

| Point | `/gsd-quick` | `/gsd-quick-batch` |
|---|---|---|
| `plan:pre` | Always. S and G before the planner spawns; C into `planner`. | Per planning invocation (D3, D4), in `planner-wave.md` step 3 next to the legacy dispatch. |
| `execute:post` | After every successful executor run, **whatever the flags**: for an isolated run after the Step 6 merge-back succeeded, otherwise right after the executor returns. Always before Step 6.25. No dispatch when the merge-back fails. S and G. | Per item, serially in manifest order, once the item is recorded as merged (D4), before verification and `quick-batch complete`: in `merge-wave.md` after step 5 routes the `worktree.cleanup-wave` result, and with `ISOLATION=none` in `worktree-dispatch.md` step 4, once that step has found the item's `SUMMARY.md` after every item of the round returned. So with `ISOLATION=none` an item's `execute:post` runs after the later items of its round have executed, not right after its own executor; per-item hooks assume nothing about their peers (D3). |
| `verify:pre` | With `--validate`, before the verifier, in `quick/steps/quick-verification.md`. S and G; C into `orchestrator`. | Per item, with `--validate`, in `verification-wave.md`. |
| `verify:post` | With `--validate`, after the verifier, **only when its status is `passed`**. S and G. | Same condition, per item, in `verification-wave.md`. |
| `discuss:pre` / `discuss:post` | With `--discuss`, in `quick/steps/discussion-phase.md`. S and G; C into `orchestrator` at `discuss:pre`. | Not applicable (`--discuss` is rejected). |
| `plan:post`, `execute:pre`, `execute:wave:*`, `ship:*` | Not supported. | Not supported. |

**Quick contributions exist at three points, and the verify and discuss ones go to the
orchestrator.** In quick a contribution is valid only at `plan:pre` (into `planner`), `verify:pre`
and `discuss:pre` (into `orchestrator`). A contribution at `verify:post` or `discuss:post` is a
validation error in quick, even into `orchestrator`, which the phase loop admits there: nothing
follows those points in quick for its text to shape. `workflows/verify-work.md` publishes
`verify:pre` and `verify:post` with `agent-roles: orchestrator`, and
[ADR-894](894-capability-declaration-format.md) keeps the `verify` step orchestrator-only. The quick
hosts follow that rule and amend nothing. A `verify:pre` contribution is injected into the quick
orchestrator's own context where its step file starts (`quick/steps/quick-verification.md`,
`quick-batch/steps/verification-wave.md`), before the verifier spawns. It never reaches the
`gsd-verifier` prompt. The `discuss:pre` contribution follows the same rule in
`quick/steps/discussion-phase.md`.

**One `verify:post` condition for both hosts.** `verify:post` runs only after a `passed` verdict.
After `gaps_found`, `human_needed` or a status the query could not resolve, each host keeps its
v1.21.0 routing, and no `verify:post` runs. In `/gsd-quick` that routing is the offer to re-run the
executor or accept on `gaps_found`, and continuing on `human_needed`
(`quick/steps/quick-verification.md`). In quick-batch it is the item's `fail` or `human_needed`
route (`quick-batch-dispatch.cts`). Accepting a result as-is never counts as `passed`.

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
  supports in the running version is a manifest validation error: a point such as `plan:post` or
  `execute:pre`, `verify:*` before increment 2, a contribution at `execute:post`, `verify:post` or
  `discuss:post`, or a contribution into any target other than `planner` at `plan:pre` and
  `orchestrator` at `verify:pre` and `discuss:pre`.
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

- **`resume <slug>`** (`commands/gsd/quick.md`), through the resume contract (D3):
  - **The same task.** The resume keeps the task's quick id, task directory and slug; it never
    allocates new ones. `<quick_id>-TASK.json` keeps its original description, modes and ids when
    present and valid. Only core's `executed_head` writes change it (D3). It is written as at a first
    run when it is absent and an annotated hook is now scheduled. An invalid file stops the resume
    with a diagnostic, and core never rewrites it.
  - **Planning.** When the task has no `PLAN.md`, the run re-enters before its first enabled
    pre-planning stage, in the order a first run uses: discussion with `--discuss`, then research,
    then the planner, or research before discussion when `workflow.research_before_questions` is
    enabled (`quick.md` Step 4, #3894). It re-enters with the full description (D3), and the
    annotated `discuss:*` and `plan:pre` steps, gates and contributions run as at a first run. A
    gate that stopped the task there is re-evaluated. A task with neither `TASK.json` nor `PLAN.md`
    has nothing to resume from: the resume stops with a diagnostic, as v1.21.0 needs a `PLAN.md`.
    When a `PLAN.md` exists, no planner spawns and no `discuss:*` or `plan:pre` hook runs.
  - **The new re-entry.** It applies to a task with no STATE.md row whose `<quick_id>-TASK.json`
    records an `executed_head` (D3) that is reachable from HEAD. Core writes `executed_head` only once
    the executor succeeded and, when isolated, its merge-back succeeded, and before the first annotated
    `execute:post` hook. Its reachability is the same ancestry evidence quick-batch uses (D4). Such a
    task does not re-spawn the executor. That is the state an `execute:post` gate stop leaves, a crash
    during the `execute:post` dispatch, and a stop or crash at a later point. The resume continues at
    the annotated `execute:post` dispatch, so every annotated `execute:post` step runs again and a gate
    that stopped the task is re-evaluated. When no `execute:post` hook is annotated, that dispatch is
    empty and the run continues at Step 6.25. The rest of the run follows as usual.
  - **What the artifacts alone do not prove.** None of these is enough without `executed_head`: a
    complete `SUMMARY.md` (an isolated merge-back rescues it into the checkout before it merges), the
    task's commits as the evaluation-scope resolver lists them (they include the pre-dispatch artifact
    commit), or a missing worktree. A task with no `executed_head`, or one that HEAD no longer reaches
    (after a reset, say), re-enters as in v1.21.0. No `execute:post` hook runs before a successful
    executor run and merge-back.
  - **Other tasks.** Every other resume re-enters as in v1.21.0, and annotated hooks run at each
    point the resumed run passes.
  - **Hooks are read live.** `/gsd-quick` has no frozen schedule, so a resume renders the hooks of
    the capabilities active at that moment. A capability enabled, disabled or upgraded between the
    stop and the resume changes which hooks the resumed run dispatches. This is intended: a task is
    one short run, and freezing its hook set would need the batch's schedule and ledger (D4), which
    `/gsd-quick` does not have. quick-batch, whose runs span many items and resumes, freezes it.
- **The `gaps_found` re-run** ("Re-run executor to fix gaps"). Today
  `quick/steps/quick-verification.md` defines only that menu line, not what the re-run does.
  Increment 1 defines it as Step 6 again, under the same isolation as the first run: an isolated
  re-run spawns a new executor worktree and merges it back as Step 6 does. Its success has the same
  definition as the first run's: the executor returned success and, when isolated, its merge-back
  succeeded. Core resets `executed_head` before the re-run and sets it after that success (D3). The
  annotated `execute:post` dispatch then runs again, and the verifier runs again, with the annotated
  `verify:*` hooks around it and `verify:post` only after `passed`. Whether Step 6.25 runs again is
  unchanged.

Built-in code review is not part of the matrix. It stays a full-mode specialization of `/gsd-quick`,
runs once, and quick-batch gains none.

### D3 — The quick invocation contract

Annotated hooks dispatched on a quick path receive quick context instead of phase context:

- **Command steps and query gates** run with `--quick "<quick_id>" --quick-modes "<set>"` instead of
  `--phase`. A quick id is never passed as a phase number.
- **Skill steps, agent steps, gates and contributions** receive the quick id, the task directory
  (`<planning_root>/quick/<id>-<slug>/`, the workstream-aware planning directory that `query
  init.quick` resolves), the working directory, the resolved modes, and the batch id when there is
  one, as one **quick context** object: `{ "quick_id", "task_dir", "cwd", "modes": [...],
  "batch_id", "planning", "items" }`. For a `/gsd-quick` task or a batch item, `quick_id` and
  `task_dir` name the task, `planning` and `items` are `null`, and `batch_id` is `null` outside a
  batch. For a batch planning invocation (below), `quick_id` and `task_dir` are `null`, `planning`
  is the invocation id, and `items` lists its members as `[{ "quick_id", "task_dir" }]`. Query gates
  take the command-step argv in both cases. Core builds it from its own state; no workflow assembles
  it by hand. In `/gsd-quick`, `loop render-hooks <point> --context quick --quick <id>` builds it.
  That `--quick` is a new value flag of `loop.render-hooks` (`src/cli-surface.cts`); the render
  finds the one directory `<planning_root>/quick/<quick_id>-*/` whose `TASK.json` names that id, and
  reads the slug, the modes and the batch id from that file and returns the object in its envelope.
  In quick-batch, dispatch never goes through render (D4), so `quick-batch due-hooks` builds it. It
  reads `BATCH.json`, the stored modes and the item's or the invocation's membership, and returns it
  as `quick_context` next to the due entries. A skill step gets the object's JSON as the `args`
  string of its `Skill(...)` call. An agent step gets it as a `<quick_context>` block at the start
  of its prompt. Contributions get one `<quick_context>` block per target prompt, in front of the
  injected fragments. The values come from core, never from user text (the description is not in
  it), and nothing is passed through the environment.
- **Resolved modes** are the set of `discuss`, `research` and `validate` after quick's flag
  normalization, so `--full` and the three granular flags yield the same set. Raw arguments are never
  passed. On a command line the set is written comma-separated, in the fixed order
  `discuss,research,validate`, with no spaces and no duplicates, and the empty set is the literal
  `none`: `^(none|discuss(,research)?(,validate)?|research(,validate)?|validate)$`. In the quick
  context object it is a JSON array in the same order, and the empty set is `[]`.
- **The task description never goes on a command line.** It is free user text. Hooks read it from
  `<quick_id>-TASK.json` in the task directory, which keeps the dispatch contract's rule that command
  arguments are validated, not interpolated:
  - **Schema:** `{ "schema_version": 1, "quick_id", "slug", "batch_id" (or null), "description",
    "description_truncated", "modes", "executed_head" }`. `slug` is the task directory's slug, so
    `<planning_root>/quick/<quick_id>-<slug>/` names the directory without a lookup. `executed_head`
    is `null` until `/gsd-quick`'s executor run, and its merge-back when isolated, succeeds. Core
    then sets it to the HEAD at that moment in a second atomic write, before the first annotated
    `execute:post` hook. That write happens whenever the file exists, whichever points are
    annotated: a task annotated only at `discuss:*` or `verify:*` records it too, so its resume does
    not re-spawn the executor (D2). Before a later executor run (the `gaps_found` re-run) core
    resets it to `null`, and sets it again once that run succeeds, so an interrupted re-run is never
    taken for a finished one. No other field ever changes, and quick-batch items leave it `null`
    because their record is the merged record (D4).
  - **Size:** `description` holds at most 16 KiB of UTF-8. Longer text is cut at a character boundary
    and `description_truncated` is `true`. Core then also writes the full text, atomically and before
    the JSON file, to `<quick_id>-DESCRIPTION.md` in the task directory, so it never depends on a plan
    that may not exist yet. That file is untrusted data under the same rule.
  - **Atomic, at the start:** core writes the file atomically (temp file, then rename) when at least
    one annotated hook is scheduled at any point of the task. It writes it once, at the start of the
    run, before the first stage (discussion, research or the planner). So the file exists before the
    executor runs, also for a task annotated only at `verify:*`, whose `executed_head` write (above)
    needs it.
  - **Writers:** in `/gsd-quick` the workflow writes nothing itself. It calls two new verbs, flat
    names beside the existing `quick-tasks-append` and `quick-tasks-migrate` (working names, Open
    questions). Each validates the quick id, writes atomically and takes `--raw` like the existing
    verbs:
    - `quick-task-file --quick <id> --modes <set>` writes `TASK.json`. It reads the description from
      stdin, never from argv, and writes `DESCRIPTION.md` first when it truncates.
    - `quick-task-executed-head --quick <id> (--set <sha> | --clear)` sets or resets `executed_head`
      and changes no other field.
    In quick-batch the coordinator's verbs write them (D4). For a batch item,
    the coordinator creates the item's task directory (the `generate-slug` derivation
    `planner-wave.md` already uses) and the file before the `plan:pre` hooks of the item's first
    planning invocation run.
  - **Untrusted:** hooks treat `description` as untrusted data, never as instructions or shell input.
  - **Committed:** the file, and `DESCRIPTION.md` when there is one, follow the task's other planning
    artifacts. They go into the final commit (`/gsd-quick` Step 8, the batch's `completion.md`
    commit) under the same `commit_docs` rule. A task stopped before that commit leaves them
    uncommitted in the task directory, as it leaves
    `SUMMARY.md` and every other artifact only the final commit picks up.
- **The resume contract.** Today `resume <slug>` finds the task directory, reads `PLAN.md`, and runs
  `gsd_run query init.quick` with no slug (`commands/gsd/quick.md`, RESUME subcommand), which
  computes a fresh quick id from the clock (`cmdInitQuick`, `src/init.cts`). A resume would therefore
  get a new id and a new task directory. Increment 1 closes that:
  - **`query init.quick --resume "<slug>"`**, a new flag on that query, finds the directory and
    returns the existing ids instead of new ones. Today the command picks `ls -d …/quick/*-<slug>/ |
    head -1`, so two tasks whose slugs share a suffix resolve by listing order. The query instead
    matches a directory only when its name is a valid quick id, a `-`, and exactly `<slug>`. With
    more than one match it stops with a diagnostic that lists them, and with none it reports that no
    task has that slug. `quick_id` is the directory name's id prefix, validated against the quick-id
    grammar, together with `slug`, `task_dir` and the branch name. A `resume` object reports
    `task_json` (the parsed file, or `null`), `task_json_error` (a diagnostic, or `null`),
    `has_plan`, `has_summary`, `state_row` and `executed_head_reachable` (`null` without an
    `executed_head`). It never allocates an id and never writes. It also builds the section manifest
    from the recorded modes, not from flags (D2): a resume without mode flags includes the
    `discussion-phase`, `research-phase`, `plan-checker-loop` and `quick-verification` sections the
    task's `TASK.json` modes enable, and returns those modes, from which `quick.md` sets
    `$DISCUSS_MODE`, `$RESEARCH_MODE` and `$VALIDATE_MODE` instead of from the flags. It then applies
    the same normalization a first run does (`quick.md`): all three set means `$FULL_MODE`, so a
    resumed full-mode task still runs Step 6.25 and the legacy `execute:post` dispatch. A flag that
    differs from the recorded modes is refused. A task without `TASK.json` keeps today's
    flag-derived manifest.
  - **The command** takes the description from `<quick_id>-TASK.json` when it is present and valid,
    from `<quick_id>-DESCRIPTION.md` when the JSON says `description_truncated`, and from `PLAN.md`
    otherwise. It stops with a diagnostic when `task_json_error` is set, when a truncated description
    has no `DESCRIPTION.md`, or when neither `TASK.json` nor `PLAN.md` exists.
  - **The workflow** gains a named re-entry, a `resume-entry` section in `quick.md`, which routes by
    the `resume` object. When `has_plan` is false it re-enters before the first pre-planning stage
    the recorded modes enable, in the first run's order (D2, including
    `workflow.research_before_questions`). A gate
    that stopped the task at `discuss:*` or `plan:pre` is therefore re-evaluated, never skipped. It
    goes to the annotated
    `execute:post` dispatch when `state_row` is false and `executed_head_reachable` is true. In every
    other case it resumes as in v1.21.0.
- **Batch `plan:pre` is per planning invocation.** Planning recomputes waves and only plans pending
  items, so a layer number does not identify a stable item set across resumes. Each planning
  dispatch gets a planning-invocation id, persisted with its item membership before any hook runs
  (D4). The id is a per-batch sequence number matching `^[1-9][0-9]{0,5}$`, validated before it is
  passed. The quick id is validated the same way (`^\d{6}-[0-9a-z]{3}$`), and so is the batch id.
  The loader's `SAFE_BATCH_ID_RE` (`^[0-9a-zA-Z-]+$`, `src/quick-batch.cts`) is not enough on a
  command line, because it accepts a leading `-` that a third-party command could read as an option.
  `createBatch` allocates the batch id from the quick-id grammar, so the check never fails for a
  batch core created. A hand-made id that fails it is refused before dispatch, like an invalid quick
  id. Hooks receive the batch id, the invocation id and the items (quick ids and task directories).
  Command steps get `--quick-batch "<batch_id>" --planning "<invocation_id>"` and the batch's modes
  as stored at `create` (D4), with no per-item flag and no single `--quick`. A command step reads
  the invocation's item membership from `BATCH.json` through the read-only `quick-batch
  planning-members` verb keyed by those two ids (D4), never from a list of items on its command
  line.
- **Per-item batch hooks run after their own item's merge.** The merge step merges the mergeable
  prefix of a wave in one `worktree.cleanup-wave` call, and an entry can fail on its own
  (`quick-batch/steps/merge-wave.md`). A per-item `execute:post` runs only for an item recorded as
  merged (D4), after that call returns. Wave peers may or may not be present in the checkout: those
  merged in the same call are, later or failed ones are not. A hook must assume neither.
- **A hook finds its task's work through the evaluation-scope resolver.** That resolver is
  `check evaluation-scope --quick "<quick_id>"`, [ADR-5057](5057-one-owner-per-workflow-verdict.md) §4,
  the one `/gsd-quick` Step 6.25 already uses. It returns the commits on the current branch whose
  message contains the quick id (a fixed-string `git log --grep`, `src/gate-evaluation-scope.cts`). A
  hook never derives a commit range, a `BATCH.json` commit or the working-tree diff on its own. In
  core, `scripts/lint-evaluation-scope-drift.cjs` already fails CI on such derivations in the gate
  modules, workflows and agents it scans (its shapes S1 to S5, including a shell `git log --grep`).
  A third-party hook is outside that scan, so for it this is the contract, not a check.
  - **What makes the id appear.** Today only `/gsd-quick`'s own commits are sure to name it: the
    pre-dispatch artifact commit of an isolated run (`docs(<quick_id>): …`) and the final commit
    (`docs(quick-<quick_id>): …`). The executor prompts say only "commit each task atomically"
    (`quick.md` Step 6, `quick-batch/steps/worktree-dispatch.md`), and the isolated merge commit is
    `chore: merge executor worktree (<branch>)` (`src/worktree-safety.cts`). Increment 1 (for
    `/gsd-quick`) and increment 3 (for quick-batch) add one rule to each executor prompt: every
    commit subject names the task as `<type>(quick-<quick_id>): …`, the form Step 8 already uses.
    `gsd-executor` writes `{type}({phase}-{plan}): …` (`agents/gsd-executor.md`), so the rule does
    not add a second format. The quick prompts hand the executor `quick-<quick_id>` as the value it
    puts in that scope, in place of `{phase}-{plan}`, and the agent's own format is unchanged.
    Besides the prompt-text test, a behavior test makes commits in that form in a fixture repository
    and checks that `check evaluation-scope --quick <id>` resolves them.
  - **When the resolver finds nothing.** An executor is an agent and can miss the rule, so the
    contract does not rest on it. A `resolved` result with no commits to evaluate means nothing to
    evaluate, never a failure, whatever its reason: `no-matching-commits` (no commit names the task),
    `merge-only` (only merge commits do) or `empty-after-exclusions` (the matched commits touch only
    excluded paths) (`src/gate-evaluation-scope.cts`). An `unresolvable` result (exit 69) is an
    error of that hook: a step gets `error` and the host continues, and a gate follows its
    `onError`.
  - **The list is capped.** The resolver returns at most `--max-commits` commits (default 200,
    ceiling 1,000, `clampMaxCommits`) and does not say when it cut the list. A quick task stays far
    below that. A hook that must see every commit asks for the ceiling, and treats a list at the cap
    as possibly incomplete. Core's own records never depend on the resolver: the
    `ISOLATION=none` merged record stores the HEAD after the executor (D4).

An annotated hook accepts this contract. That is the meaning of listing `"quick"`.

### D4 — quick-batch dispatches through the coordinator, with checkpoints

quick-batch dispatches hooks from its coordinator through the same shared primitives, never by
running `/gsd-quick` per item. [ADR-1239](1239-gsd-embeddable-orchestration-engine.md)'s single-writer
ownership of `BATCH.json`, STATE.md and worktree merges is unchanged.

**`BATCH.json` schema 2.** The frozen schedule, the planning invocations and the outcome ledger are
fields of `BATCH.json` itself, never a second file, so `BATCH.json` stays the sole source of truth for
completion ([ADR-1239](1239-gsd-embeddable-orchestration-engine.md)). So are the recovery records
that close two crash windows v1.21.0 already has (below): the merge-in-flight record, the merged
record and the verifier status, each written together with `head_revision` (HEAD across resume,
below). Those windows are not tied to annotated hooks, so their fix is not either:

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
  - **No recovery record goes into a v1 batch.** A v1.21.0 loader rebuilds from known fields, so a
    recovery record stored under `schema_version: 1` would vanish silently on the first rewrite by
    such a core. `head_revision` (#6203) is an optional v1 field that core added after v1.21.0, and
    the same loss applies to it. It can stay a v1 field because its loss fails closed: without it,
    `resumeBatch` falls back to `base_revision` and refuses a moved HEAD with its recoverable
    diagnostic. A lost merge-in-flight or merged record would not fail closed. The work would be
    merged with no record of it. So those records exist only in schema 2.
- **Rollback:** an older core refuses a v2 batch, as it refuses any unknown schema today. That
  includes a batch with no annotated hooks and an upgraded v1 batch. The refusal fails closed. It is
  the intended rollback behavior, and the changeset says that a batch in flight must be finished
  before a downgrade.

**The frozen schedule.**

- **When it is frozen.** The schedule is resolved once, when the batch starts. It records every
  annotated hook at a cell quick-batch supports, active or not, so a capability enabled, disabled or
  upgraded mid-batch does not change a running batch. Each planning invocation is persisted (id,
  item membership, the identities of the `plan:pre` entries it schedules) before its hooks run.
- **The modes are frozen with it.** Which cells apply to an item (`verify:*` only with
  `--validate`), the completion rule and the modes handed to hooks all depend on the batch's modes.
  Today `quick-batch create` gets no modes (`batch-init.md`), and every invocation, `--resume`
  included, re-parses `--validate` and `--research` (`quick-batch.md`). So `batch-init.md` passes
  the parsed set to `create` through the flag it already has, `--options '{"modes": [...]}'`. The
  value is a JSON array of distinct strings from `research` and `validate`, in that order; `[]` is
  the empty set. It lands in the `options` field, which `BATCH.json` v1 already persists and
  round-trips verbatim, so even a v1.21.0 loader keeps it. Today `options` is never interpreted;
  from increment 3 core validates and reads `options.modes`, and nothing else in `options`.
  Everything above reads the stored set. `--resume` reads it too: flags given on a resume that
  differ from it are refused with a diagnostic that names the stored set, and a resume with no mode
  flags uses it.
- **The stored modes reach the section loading.** `quick-batch.md` loads its `research-phase` and
  `verification-wave` steps through `<!-- gsd:section … when="flag:--research" -->` and
  `when="flag:--validate"`. `query init.quick-batch` builds that manifest from the flags it is
  given, before the batch is loaded. So `init.quick-batch` gains `--resume <batch_id>`: it loads
  `BATCH.json` first, refuses differing flags, and builds the manifest from the stored
  `options.modes`. A resume with no flags therefore still loads `verification-wave` for a batch
  created with `--validate`. The init result also carries the stored modes, and `quick-batch.md`
  sets `$VALIDATE_MODE` and `$RESEARCH_MODE` from them rather than from the invocation's flags. The
  loaded step files skip themselves when their variable is false, so restoring the sections alone
  would not run them. A batch without `options.modes` keeps the flag-derived manifest and variables.
  Delivery 3 tests that the resumed batch actually runs verification, not only that the section
  loads.
- **A batch with unknown modes.** A batch created before increment 3 has no `options.modes`, and no
  later writer adds one, because no writer but `create` is given the modes. Its schedule is empty,
  so no annotated hook depends on them. For such a batch every invocation keeps today's behavior:
  `--resume` re-parses `--validate` and `--research`. `quick-batch complete` and the STATE-row
  recovery in `resumeBatch` apply no verdict condition to it, as v1.21.0's do, because neither verb
  is given the modes. The verification wave routes its items as today.
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
  follows its `onError`: `error-skipped` under `skip`, `held` under `halt`.
- **What is scheduled.** For an item or a planning invocation, the scheduled hooks are every frozen
  entry at the cells that apply to it, active or not. An entry whose activation was false at freeze
  gets its `skipped` row in the freeze write itself, and that row counts as a sticky outcome.
- **Contributions are snapshots, not checkpoints.** A contribution is prompt content, not a side
  effect. Its resolved fragment is stored with the frozen schedule and injected into every spawn of the
  target agent, including replacement and revision spawns after a resume. It is never marked done.
- **Size.** `loadBatch` parses `BATCH.json` with `safeJsonParse(raw, { maxLength: 1048576 })`
  (`src/quick-batch.cts`) and fails closed above it. The cap counts the JavaScript string length of
  the file's text (UTF-16 code units, `src/security.cts`), not bytes. That cap stays, and the schema
  is bounded so a batch never outgrows it through its own writes. Every limit below except the
  fragment cap is measured the same way, on the text the writers write: the length of
  `JSON.stringify(manifest, null, 2) + '\n'` (`src/quick-batch.cts`), indented, not compact JSON.
  The boundary tests count what the loader counts:
  - **Stored once.** Each snapshot is stored once in the schedule, keyed by its SHA-256. Planning
    invocations and ledger rows refer to entries by identity, never by copy, so a fragment's size
    counts once per batch, not once per item or invocation.
  - **Caps at freeze.** A contribution fragment holds at most 16 KiB of UTF-8, and the frozen
    schedule, as it appears in that indented text, is at most 262,144 code units long. Over either
    cap, `quick-batch create` refuses the batch with a validation error that names the capability
    and the hook. It never truncates a fragment.
  - **Budget at freeze.** `create` also refuses a batch whose worst case exceeds the cap: the v1
    fields, plus the schedule, plus items × the per-item entries scheduled for each × the largest
    ledger row, plus the merge and verifier records.
    - **The row.** The ledger is a top-level `ledger` array of flat objects
      `{ "quick_id" | "planning", "capability_id", "point", "kind", "index", "sha256", "outcome" }`
      in that key order: the key (a quick id, or a planning-invocation number), the hook identity and
      the outcome. A row holds no HEAD: `head_revision` is one manifest-level field, set in the same
      write (below). Rows sit at depth 2 of the indented text.
    - **An example.** A row with a quick id, an 18-character capability id, a two-digit index and the
      longest checkpointed names (`execute:post`, `gate`, `error-skipped`) is 279 code units in the
      indented text, its separator included (213 compact). The example takes the schedule at its
      262,144 cap and 100,000 code units for the v1 fields and the merge and verifier records. Then
      (1,048,576 − 262,144 − 100,000) / 279 ≈ 2,460 rows fit, enough for 100 items with 24 hooks
      each (2,400 rows). The rule is the computed budget, not this example: `create` sums the actual
      schedule and the actual per-item entries.
  - **Guard at write.** Planning invocations are not bounded at freeze, because a crash during
    planning adds one. So every writer serializes the new manifest first and refuses a write that
    would exceed the cap. The previous file stays intact and the verb returns a diagnostic, so the
    batch stops readable rather than unreadable.

**Outcomes.** Steps and gates are checkpointed: per-item hooks by item, point and hook identity;
`plan:pre` hooks by planning invocation, point and hook identity. Each outcome is written under
`withPlanningLock` in the same write as the HEAD after it (see below).

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
  same.
- **Merged record.** One write records an item as merged. It sets the item's `commit`, clears its
  merge-in-flight record, clears the `dispatched_worktree`, `dispatched_branch` and `dispatched_base`
  fields (#3677) unless the worktree was left on disk, and records HEAD. For a v2 batch this write
  replaces `merge-wave.md`'s separate `quick-batch update` that clears those three fields, so no state
  exists in which the fields are cleared but the item is not yet marked merged. `commit` holds one
  value:
  - **Isolated:** the `--no-ff` merge commit that brought the item's branch in.
  - **`ISOLATION=none`:** the HEAD after the executor returned, the value the same write records as
    `head_revision`. It never comes from the evaluation-scope resolver, which can find no commit for
    an item (D3). An executor that made no commit leaves HEAD where it was, and that HEAD is the
    `commit`.

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
- **The verifier status is recorded per item.** With `--validate`, each item gets a
  `verifier_status` field, outside the hook ledger (whose rows are hook identities, so a verifier
  row would match no snapshot entry). It holds the verifier's status, in its existing vocabulary
  (`passed`, `gaps_found` or `human_needed`, `VerifierStatus`), for every v2 batch. It is written
  when the verifier returns, and resume re-runs the verifier only when no status is recorded. That
  closes the second v1.21.0 crash window, a crash between the verifier's return and its routing.
  `verify:post` follows only `passed` (D2), and `gaps_found` goes through the existing `fail`
  routing (`quick-batch-dispatch.cts`).
  - **Which recorded statuses are final.** `passed` and `gaps_found` are. A recorded `human_needed`
    is not: it records that the verifier ran, and the verdict stays with the report. Today a resume
    re-derives each item's progress from the artifacts on disk (`resume-mode.md`), and the
    verification wave runs only for a merged item "that has not yet been verified"
    (`verification-wave.md`). So an item whose `VERIFICATION.md` says `human_needed` is never looked
    at again. Increment 3 changes that for a v2 batch: every resume re-reads such an item's report
    through `verification.status`, without re-running the verifier. Once a person resolves the
    review in the report and the query returns `passed`, that status is recorded and the item
    continues at `verify:post`. While it returns `human_needed`, the item stays held. Any other
    value takes the existing `fail` routing.
- **Completion requires the ledger.** `quick-batch complete` refuses an item, and does not append
  its STATE row, while any scheduled step or gate lacks a sticky outcome or, when the stored
  `options.modes` include `validate`, the item's `verifier_status` is not `passed`. Both verbs read
  the modes from `BATCH.json`, never from a flag. The STATE row therefore exists only once the
  ledger is complete. For a v2 batch, `resumeBatch`'s crash-window shortcut (STATE row present, so
  complete) also checks the ledger. If the ledger is incomplete despite a row, which can only happen
  through a hand edit, the item stays `pending` and its missing hooks run.
- **A held item.** A `held` gate leaves its item `pending` and merged, with the ledger recording
  `held`. The rest of the batch continues, and the completion report lists held items with the
  gate's message. The item's dependents stay ineligible, because eligibility needs every dependency
  `complete`. They are not marked `blocked`, so they become eligible on the resume that completes
  the held item. Once the user fixes the cause, `--resume` re-evaluates the `held` gate and
  continues from there. Sticky outcomes are never replayed, and there is no retry policy beyond
  `onError`.

**HEAD across resume.** Since #6203 (fixed in #6296) the manifest records `head_revision`, the HEAD
the batch last recorded for itself, and `resumeBatch` refuses a HEAD other than
`head_revision ?? base_revision` when it is given `--current-base-revision` and `base_revision` is
non-null (`src/quick-batch.cts`). `resume-mode.md` always passes the current HEAD. The step files set
`head_revision` with a separate `quick-batch update --head-revision` after an inline executor returns
(`worktree-dispatch.md`), after each `worktree.cleanup-wave` call (`merge-wave.md`) and after the
final commit (`completion.md`). Equality holds only while nothing moves HEAD between two of those
writes. Annotated hooks break that: a hook's commit, or a user's commit that fixes a held item's gate,
moves HEAD with no write, and so does a crash between a hook's side effect and its checkpoint.
Increment 3 keeps `head_revision` as the one recorded HEAD, and for a v2 batch:

- **Recorded in the same write.** Every recovery write (merge-in-flight and merged records, a hook
  outcome in the ledger, an item's `verifier_status`) also sets `head_revision` to the HEAD at that
  moment, in the same `withPlanningLock` write. The merged-record writes replace the separate
  `--head-revision` updates in `worktree-dispatch.md` and `merge-wave.md`, so no state exists in
  which an item is merged but the HEAD is not recorded. The update after the final commit in
  `completion.md` stays, because no recovery write follows that commit.
- **Ancestry, not equality.** Resume accepts any HEAD that is `head_revision ?? base_revision` or
  descends from it. The commits after it are not attributed to anyone. The batch reconciles from its
  ledger, never from which commits exist. Merges keep their own per-entry `--expected-base` check.
- **Refused HEADs.** A HEAD that does not descend from it (a reset, a rebase, or a switch to another
  branch) is refused with the recoverable diagnostic
  [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) requires. This is the "diverged in a way the
  coordinator cannot reconcile" case of ADR-1239, and the batch's merged base keeps moving forward as
  that ADR states.
- **Crash window.** A crash between a hook's side effect (a commit, say) and its checkpoint leaves
  HEAD ahead of `head_revision`. That HEAD is accepted, and the hook re-runs because it has no
  outcome. This is why annotated hooks must be idempotent.

Because every batch a core with increment 3 writes is schema 2, the rule covers every batch such a
core resumes. A v1 batch is checked under the same ancestry rule before the first write upgrades it.

**Further rules.**

- **No exactly-once guarantee.** A crash between a hook's side effect and its checkpoint re-runs that
  hook. Annotated steps and gates must be idempotent, and the capability how-to
  (`docs/how-to/develop-a-capability.md`) says so.
- **Planning invocations.** Planners for an invocation spawn only after every `plan:pre` step and
  gate of that invocation has a sticky outcome. A `held` gate holds the invocation and its items
  unplanned. Resume re-evaluates it like any `held` gate.
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
    N at its first ledger entry without a sticky outcome, which includes a `held` gate.
- **Batches started before the upgrade** carry `schema_version: 1` and no frozen schedule. Their
  first write upgrades them to 2 with an empty schedule, so their hooks keep v1.21.0 dispatch.
  Completed items stay complete as [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) requires,
  and no annotated hook runs retroactively for any of their items. They do gain the recovery records:
  the merge-in-flight and merged records and the verifier status, each written with `head_revision`.
  The hook contract applies from the next batch.

**The CLI verbs.** Today's `quick-batch` verbs are `create`, `update` (`--updates`,
`--head-revision`), `resume`, `complete`, `effective-concurrency`, `merge-eligible`, `spawn-plan`,
`filter-executed`, `verification-routing`, `merge-routing`, `cleanup-entry` and `parse-args`
(`src/quick-batch-command-router.cts`). Increment 3 adds the verbs the step files and tests call.
The names are working names (Open questions). Each new verb that writes does so under
`withPlanningLock`, sets `head_revision` in the same write, and returns it in its result. Every new
verb takes `--raw` like the existing ones. A JSON argument that can be large (`--items`,
`--entries`, `--results`) also has a `--stdin` form, as `parse-args --stdin` does today.

- **A hook key.** `--hook <key>` and the `key` in `due-hooks` results are the full identity in one
  string, `<capability_id>:<point>:<kind>:<index>:<sha256>`. That is the manifest's kebab-case
  capability id (no `:`), a point name (which holds its own `:`), `step`, `gate` or `contribution`,
  a decimal index without leading zeros, and 64 lowercase hex digits. It is split at the first `:`
  and parsed from the right for the rest, so the colons inside the point never matter, and any other
  shape is refused. `due-hooks` returns contribution entries with their keys too, because their
  fragments are injected from the snapshot. `hook-outcome` accepts only `step` and `gate` keys,
  since contributions are never checkpointed.
- **`options.modes`.** A JSON array of distinct strings from `research` and `validate`, in that
  order, or `[]`.

| Verb | Writes | Arguments | Result |
|---|---|---|---|
| `create` (extended) | the frozen schedule, its `skipped` rows, and `options.modes` from `--options` | as today | as today, plus `modes` and `schedule: { entries, length }` |
| `planning-start` | a planning invocation, and each member's task directory and `TASK.json` when absent (D3) | `--batch <id> --items <json array of quick ids>` | `{ invocation_id, items: [{ quick_id, task_dir }], head_revision }` |
| `planning-members` | nothing | `--batch <id> --planning <n>` | `{ batch_id, invocation_id, items: [{ quick_id, task_dir }] }` |
| `due-hooks` | nothing | `--batch <id> (--quick-id <id> \| --planning <n>) --point <point>` | `{ entries: [{ key, kind, snapshot }], quick_context }`: the scheduled steps and gates without a sticky outcome, plus every contribution whose activation was true at freeze (each spawn gets them; they have no ledger row), in manifest order; `key` is the full identity |
| `hook-outcome` | one ledger row | `--batch <id> (--quick-id <id> \| --planning <n>) --point <point> --hook <key> --outcome <outcome>` | `{ recorded, head_revision }` |
| `merge-start` | the merge-in-flight records | `--batch <id> --entries <json array of { quick_id, tip }>` | `{ recorded, head_revision }` |
| `merge-resolve` | merged records, cleared in-flight records | `--batch <id> [--results <worktree.cleanup-wave JSON>]` | `{ entries: [{ quick_id, resolution, commit, diagnostic }], head_revision }`, `resolution` one of `merged`, `pending`, `merge_failed`, `scope_violation`, `refused` |
| `record-merged` | the merged record under `ISOLATION=none` | `--batch <id> --quick-id <id>` | `{ commit, head_revision }` |
| `verifier-status` | the verifier status | `--batch <id> --quick-id <id> --status <passed\|gaps_found\|human_needed>` | `{ recorded, head_revision }` |

`merge-resolve` applies the ancestry rule above, both right after the call and on resume. Without
`--results` (the call never returned) every entry is routed as one with no reported status.

### D5 — Logical hosts and per-host coverage

**Logical hosts** are a workflow together with its step files: `quick` (`quick.md`,
`quick/steps/**`) and `quick-batch` (`quick-batch/**`). For them, the generator checks every point,
kind and contribution target that D2 claims, per host and not as a union, and the gating mode each
cell declares. Whether the flag actually reaches the call is left to workflow tests (below).

**A separate generated contract, beside the Loop Host Contract.** The Loop Host Contract
([ADR-894](894-capability-declaration-format.md) §3) cannot hold them. In
`scripts/gen-loop-host-contract.cjs`, `assertPointsCoverage` requires each entry to declare exactly
its step's points and refuses a point declared twice, and `parseLoopHostBlock` allows one marker per
file and recognizes the keys `step`, `points`, `agent-roles`, `produces` and `consumes` only, with
no key for a kind, a target or a cell. Its consumers read one entry per point: `loop-resolver.cts`
concatenates the points, and the validator's `POINT_TO_CONTRACT` keeps the last entry for each. A
quick entry would fail the generator, or replace the phase entry for its points. So the quick hosts
get their own contract, and the existing one is left as it is:
- **The marker.** Each quick call site carries a `<!-- gsd:quick-cell host=<quick|quick-batch>
  point=<point> kinds=<step,gate,contribution> into=<target> mode=<always|discuss|validate> -->`
  marker next to its dispatch call, one per cell, any number per file. `into` is present only with
  `contribution`. A marker with an unknown host, point, kind or target, or a `into` without
  `contribution`, fails generation.
- **The check is bound to the call.** Consecutive markers form a group that governs the next
  dispatch call: `loop render-hooks <point> --context quick` in a `quick` host file, and
  `quick-batch due-hooks … --point <point>` in a `quick-batch` host file, since batch dispatch reads
  the frozen schedule instead of rendering (D4). The group's region runs from its first marker to
  the earliest of: the next dispatch call after its own call (`loop render-hooks` of any context,
  or `quick-batch due-hooks` for any point), the next marker group, or the section end. The
  section end is the next Markdown heading of any level, `<step` or `</step>` tag, or `gsd:section`
  open or close marker. `quick.md` already uses
  `gsd:section` markers, so a region never crosses one. In that region the generator requires
  exactly one such dispatch call for the marker's point, and after that call the dispatch text for
  each listed kind and target. A legacy call next to it therefore ends the region before its own
  dispatch text. Today's `scanWiredPoints` and `scanWiredKinds` aggregate by point over a whole file
  and ignore `--context`, so a legacy `--context quick-legacy` dispatch in the same file could stand
  in for a missing annotated one. The quick check therefore scans only the marker's region and
  counts only quick dispatch calls. `--context quick` matches only as a whole token
  (`--context quick` or `--context=quick` followed by whitespace or the end of the line), so
  `--context quick-legacy` never counts. Each marker is checked on its own with the existing
  `coveredKindsInRegion(region, expectedInto)` and its one `into`. A D2 cell has at most one target
  per point, so one `into` per marker covers every cell, and a call that served two targets would
  carry one marker per target. A quick dispatch call in a quick host's files outside any marker's
  region fails generation too.
- **The gating mode is declared and checked.** The marker carries `mode=<always|discuss|validate>`,
  the flag D2 gates the cell on. The generator checks it against the version table's entry for the
  cell, which records the same mode, and checks that the marker sits in the step file D2 names for
  it (`quick/steps/quick-verification.md` for the `validate` cells, say). This is a declared-placement
  check: it catches a cell moved to another file or relabeled. It does not prove the flag reaches the
  call, which the workflow tests per mode do.
- **The export.** The generated module exports a second array, `QUICK_HOST_CONTRACT`, as `[{ host,
  cells: [{ point, kind, into, mode, file }] }]`. `serializeContract` in the generator writes it and
  adds it to the module's `module.exports`. `LOOP_HOST_CONTRACT`, the five-step assertions,
  `loop-resolver.cts` and `POINT_TO_CONTRACT` stay unchanged, and none of them reads the new array.
- **Its readers.** The D1 shape validation and the version-table parity test (D2) read
  `QUICK_HOST_CONTRACT`.
- **Where the version table lives.** `capability-validator.cjs` is a committed plain `.cjs` that
  requires the generated contract module, so that it works before `npm run build:lib`. The version
  table is another committed, hand-authored plain `.cjs` beside it,
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
`quick-batch`. Today's validator pools producers globally (`capability-validator.cjs`); the quick
hosts get their own pools. The phase pool changes too: it takes only hooks that run in the phase
loop (field absent or listing `"phase"`). So a `["quick"]` producer never satisfies a phase
consumer. A consumer whose producer only runs under an optional mode must degrade gracefully when it
did not run, as [ADR-894](894-capability-declaration-format.md) already requires of self-gated
producers.

The phase hosts keep the existing union check. Converting them to per-host coverage is out of scope.

## Delivery

Three increments, each its own PR.

**The compatibility test comes first.** It is the first commit of increment 1's PR and passes on its
own against unchanged `next`, before any other commit of that PR. It asserts that an unannotated
manifest dispatches exactly as v1.21.0 on every quick and quick-batch path and flag set. Increments
2 and 3 merge only with it green on their own head, and it stays in the suite afterwards.

1. **The field and `/gsd-quick` `execute:post`.**
   - Schema and validation: the D1 field shapes, the unsupported-shape error (point, kind and
     contribution target), the floor check, the version table and its parity test against the
     generated contract.
   - Context filtering in `loop render-hooks`: `--context quick` and `--context quick-legacy`. Every
     legacy quick call site moves to `--context quick-legacy`.
   - A new `/gsd-quick` `plan:pre` dispatch for annotated hooks: steps and gates before the planner
     spawns, contributions into `planner`. It sits next to the legacy contribution injection, which
     keeps serving unannotated hooks.
   - The D3 contract, including `<quick_id>-TASK.json`, the quick context object, the
     `--quick-modes` grammar and the commit-subject rule in the `quick.md` executor prompt.
   - An `execute:post` dispatch for annotated hooks that runs whatever the flags.
   - The `gaps_found` re-run in `quick/steps/quick-verification.md`: the `executed_head` reset before
     it and the annotated `execute:post` dispatch after it (D2, D3). These ship with `executed_head`
     itself, so no release writes `executed_head` without resetting it before a re-run.
   - The logical `quick` host (D5): the `gsd:quick-cell` marker, its check and the
     `QUICK_HOST_CONTRACT` export in `scripts/gen-loop-host-contract.cjs`, with cells for `plan:pre`
     and `execute:post`. The same script writes the generated quick matrix region in
     `references/loop-hook-dispatch.md` (D2).
   - The `/gsd-quick` writer verbs `quick-task-file` and `quick-task-executed-head` (D3).
   - The resume contract and the `resume <slug>` re-entry (D2, D3): `query init.quick --resume` in
     `src/init.cts`, the RESUME subcommand in `commands/gsd/quick.md`, the `resume-entry` section in
     `quick.md`, and the CLI surface manifest.
   - Tests: besides the compatibility test,
     - an annotated `execute:post` step under `--full` runs exactly once and never with `--phase`;
     - a `["phase"]` hook never runs in quick;
     - an isolated run dispatches `execute:post` only after a successful merge-back;
     - `query init.quick --resume` returns the task's existing quick id and task directory, and
       never a new one;
     - `resume <slug>` after an `execute:post` gate stop re-evaluates the gate without re-spawning the
       executor;
     - a hook given a `no-matching-commits` scope treats it as nothing to evaluate;
     - an annotated contribution at `execute:post`, or one `into: verifier`, is a validation error;
     - an interrupted `gaps_found` re-run leaves `executed_head` `null`, so the resume re-spawns the
       executor;
     - `resume <slug>` with no mode flags of a `--validate` task loads `quick-verification` and runs
       the verifier, a resumed `--full` task runs Step 6.25, and flags that differ from the recorded
       modes are refused;
     - `query init.quick --resume` refuses a slug that matches two task directories;
     - a `["quick"]` hook is absent from `resolveActiveHooksForPoint`'s default (phase) result, so
       the in-process `verify:post` audit never sees it;
     - the legacy `auxiliaryHosts` check fails when the `--context quick-legacy` dispatch is removed
       while the `--context quick` one stays;
     - installed-overlay composition: an annotated hook that reaches the hosts through an installed
       overlay is scheduled and validated exactly as one in the base manifest, since overlays use
       the same canonical builder (the issue's test list).
2. **`verify:*` and `discuss:*` in `/gsd-quick`.** Dispatch in `quick/steps/quick-verification.md`
   and `quick/steps/discussion-phase.md`, contribution target `orchestrator` only, coverage extended
   to them.
3. **quick-batch.**
   - The logical `quick-batch` host.
   - Per-invocation `plan:pre` in `planner-wave.md` step 3. Per-item `execute:post` in `merge-wave.md`
     after step 5, and with `ISOLATION=none` in `worktree-dispatch.md`. Per-item `verify:*` in
     `verification-wave.md`. The completion check in `completion.md`. Resume in `resume-mode.md`.
   - `BATCH.json` schema 2 for every batch, with the loader change, the frozen schedule and its size
     rules, the ledger, the merge-in-flight and merged records, the verifier status, and
     `head_revision` written with each recovery write and checked by ancestry.
   - The new `quick-batch` verbs (D4), and the commit-subject rule in the `worktree-dispatch.md`
     executor prompt.
   - The D4 lifecycle in `quick-batch complete`, merge routing and completion recovery.
   - Tests:
     - a v2 round trip through every writer that preserves all v2 fields;
     - a v1 batch upgraded by the first write a core with increment 3 makes to it (a resume that
       records transitions, or any writing verb; a resume without transitions writes nothing and
       leaves it v1), which then keeps v1.21.0 hook dispatch;
     - a `--resume` whose mode flags differ from the stored `options.modes` is refused;
     - a `--resume` with no mode flags of a batch created with `--validate` still runs the
       verification wave, and a batch without `options.modes` keeps the flag-derived manifest;
     - a `human_needed` item whose report is resolved to `passed` continues at `verify:post` on the
       next resume;
     - a v2 batch whose annotated `execute:post` step commits resumes with that HEAD accepted, with
       no `--head-revision` update in between; a HEAD reset below `head_revision` is refused;
     - a crash inside `worktree.cleanup-wave` resolved by ancestry, for each status in the D4 routing
       list;
     - a crash between the verifier's return and its routing;
     - a recorded `human_needed` that passes once its report is resolved;
     - size limits at limit − 1, limit and limit + 1 for the fragment cap, the schedule cap and the
       write guard, the last leaving the previous `BATCH.json` intact.

Each increment adds its D2 cells, with their first supported version, to the cell table, so a
manifest's `engines.gsd` floor can name the version that supports everything it annotates.

Each increment updates `references/loop-hook-dispatch.md`, the capability how-to and tutorial, the
quick-task how-to, the CLI surface manifest where the CLI changes, and `CONTEXT.md`, and carries an
`Added` changeset. In `CONTEXT.md`, increment 1 amends `RULESET.CAPABILITY.cutover-self-gating` and
`RULESET.CAPABILITY.step-additive-gate-blocks` with D1's exception (for an annotated hook the host
applies the execution context before dispatch; self-gating stays the rule for unannotated hooks) and
adds the terms it introduces: `executionContexts`, annotated hook, the quick context object and
logical host. Increment 3 adds the frozen schedule and the outcome ledger. `CONTEXT.md` changes
with the code that makes it true, not in this ADR's PR.

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
6. **Breaking changes.** The issue's assessment says none, and that a batch started before the
   upgrade has no checkpoints. D4 moves every batch a new core writes to `BATCH.json` schema 2, so an
   older core refuses to resume it (Consequences). An upgraded batch keeps v1.21.0 hook dispatch, as
   the issue says, but gains the recovery records.
7. **Batch modes are frozen** (D4), so a `--resume` with different `--validate` or `--research`
   flags is refused for a batch created with stored modes. Today a resume re-parses them.
8. **`verify:post` runs only after a `passed` verdict.** The issue's matrix runs it "after the
   verifier returns", and its criterion has no passed-only condition. D2 runs it only after
   `passed`, on both hosts, so a hook at `verify:post` never acts on a failed or unresolved
   verification. After `gaps_found` or `human_needed` the host's v1.21.0 routing applies instead.
9. **Coverage is enforced in part.** The issue asks the generator to enforce coverage of every
   annotated host, including that each gating flag reaches its call site. D5's generator checks the
   point, kinds and target at each marked call and the declared gating mode against the step file.
   It does not prove the flag reaches the call. The workflow tests per mode cover that, so that part
   of the criterion rests on tests, not on the generator.
10. **`plan:pre` for `/gsd-quick` lands in increment 1.** The issue's first increment holds the
    field, validation and `/gsd-quick` `execute:post`. Increment 1 here also adds the annotated
    `/gsd-quick` `plan:pre` dispatch, because the motivating capability needs its planner
    contribution and its `execute:post` step to opt in together.
11. **Changes the issue does not describe.** The ADR also changes or defines:
    - **HEAD on resume:** quick-batch accepts a HEAD that descends from `head_revision` where
      `resumeBatch` today requires equality (D4).
    - **When an item counts as planned:** once its `quick-batch update` has persisted, not when a
      `PLAN.md` exists (D4; today `planner-wave.md` derives it from the files on disk).
    - **The `gaps_found` re-run:** Step 6 again under the same isolation, which today's workflow
      leaves undefined (D2).
    - **A `human_needed` item on resume:** its report is re-read on every resume, where today an
      item with a report is never looked at again (D4).

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
  `--quick-modes`, `--quick-batch`, `--planning`, `query init.quick --resume`), the render contexts
  (`quick`, `quick-legacy`), the quick context object's keys, the `gsd:quick-cell` marker and the
  `QUICK_HOST_CONTRACT` export (D5), the `quick-task-file` and `quick-task-executed-head` verbs (D3)
  and the new `quick-batch` verbs (D4) are contract surface too. Each should be settled before the
  increment that introduces it merges, since each one is a stability contract.
- **Scope.** The #6178 verdict approved the execution-context dimension in three increments. This
  ADR also decides changes that are not tied to annotated hooks, several of them fixes for v1.21.0
  defects:
  - schema 2 for every batch, with the rollback refusal (D4);
  - the merge-in-flight and merged records, with the merge routing by ancestry (D4);
  - the persisted verifier status (D4);
  - the frozen batch modes (D4);
  - the `/gsd-quick` resume contract and `executed_head` (D2, D3);
  - the executor commit-subject rule (D3);
  - the `quick-legacy` render context (D1);
  - the HEAD ancestry rule on resume (D4);
  - the "planned once the update persisted" rule (D4);
  - the definition of the `gaps_found` re-run (D2);
  - the re-read of `human_needed` reports on resume (D4).

  Whether they stay here or move into separately approved issues is the maintainer's decision. The
  hook design depends on some of them. Per-item hooks start only once an item is recorded as merged,
  and the `/gsd-quick` `execute:post` re-entry needs `executed_head`. A split would therefore have to
  land those first, or narrow the hook cells that rely on them.
- **`fast`.** `/gsd-fast` runs inline with no hooks at all. Whether it becomes a third context is left
  to a later issue.
