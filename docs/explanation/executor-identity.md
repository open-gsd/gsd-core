# About executor identity

When `execute-phase` runs a plan, it has to answer one question before anything else: which agent is the executor for this plan? Usually it is `gsd-executor`. With [per-plan executor routing](../reference/plan-md.md#per-plan-executor-routing), a plan's `agent_hint:` can name a specialist instead. This page explains why that answer is recorded once, and why the rest of the dispatch reads the record instead of assuming `gsd-executor`.

## One decision, several readers

Three parts of a plan's dispatch depend on who the executor is:

- **Isolation guards.** On a worktree-capable host, the executor must run in an isolated git worktree so parallel plans do not edit the primary checkout at the same time. Hooks (`gsd-agent-isolation-guard.js` on Claude Code, `gsd-cursor-subagent-start.js` on Cursor) block an executor dispatch that drops the worktree flag.
- **Model selection.** The executor's model comes from `model_profile` and `model_overrides`.
- **The executor itself.** The `Agent()` call's `subagent_type`.

Before #6213, routing set `subagent_type`, but the guards and the model still assumed `gsd-executor`. The guards recognised only that one name and let every other agent through, so a specialist executor could run in the primary checkout even when the recorded decision said `harness-worktree`. The specialist also got `gsd-executor`'s resolved model, and its own `model_overrides` entry was never read.

## Why the record, and not a list of names

The guards could have been fixed by widening their list, for example to any name ending in `-executor` or to every installed agent. Both guess identity from a name. A pattern misses a specialist named differently and guards unrelated agents that happen to match. An installed-agent list guards the verifier and the planner too.

GSD already has a record of each plan's dispatch decision: the dispatch identity record from [ADR-4630](../adr/4630-dispatch-identity-and-isolation-decision-seam.md), written immediately before the plan is dispatched (`.gsd/dispatch-isolation-sentinel.json` and its per-plan keyed copy). It holds the isolation mode, the harness flag, and the phase and plan. The routed executor now goes into the same record as `executor_type`. A guard then asks a precise question: does a recent record name this subagent type as the executor? The workflow decided once, and the guards check that decision.

The recorder works the executor out for itself. When `execute-phase` records a plan's decision, it already passes the plan, so the recorder reads that plan's own `agent_hint:` and applies the same rules routing does. Routing reads the same file with the same function, so the type dispatched and the type recorded cannot drift apart. The phase-level record, written before any plan is dispatched, lists the routed executors of every plan in the phase, so a specialist is guarded from the first record onward, not only once its own plan's record lands. Nothing has to carry the routed name from one step to the next. That matters because each workflow step runs in a fresh shell: a value set in the routing step is gone by the time the record is written, and a record that silently fell back to `gsd-executor` would let the specialist through unguarded.

## The dispatch marker as a second witness

A record can go missing or out of date: a long wave outlives its freshness window, or a step that writes the plan's record is skipped. `gsd-executor` survives that, because the guard knows its name and falls back to the project's configuration. A specialist known only through the record would not.

So the guards also read the executor dispatch itself. Every executor dispatch prompt `execute-phase` builds carries a marker line, `[gsd:dispatch phase="…" plan="…"]`, and no other GSD template emits it. A dispatch is treated as the plan's executor when any one of these holds:

- (a) it is `gsd-executor`;
- (b) any well-formed dispatch record in the project names its type in `executor_type` or `executor_types`, and that record is at most 24 hours old by its `written_at` (a record dated in the future beyond a few seconds of clock skew is not recent). This covers the keyed records under `.gsd/dispatch-isolation/` and the legacy `.gsd/dispatch-isolation-sentinel.json`, and it does not matter which phase or plan the record is for;
- (c) its prompt carries the dispatch marker and its type is not a GSD role (a GSD role such as `gsd-verifier` is never classified as an executor by the marker).

The check in (b) is the same for every dispatch: it never looks at the phase or plan the prompt names, and there is no separate path for a prompt that names no phase. Enforcement is a separate step and is unchanged: once a dispatch counts as an executor, it is checked against the record that matches its own phase and plan, exactly as `gsd-executor` is, including the fallback to configuration when no usable record exists.

### The fail-closed cases

Some situations leave GSD unable to rule a type out. In each, the dispatch is treated as an executor when its type is a valid agent name and is not a GSD role (one of the roles in `MODEL_PROFILES` other than `gsd-executor`; a custom `gsd-*` executor such as `gsd-rails-executor` is not a role). GSD roles such as the verifier and the planner are never classified this way. The cases are:

- The scan overflowed. It iterates at most 1024 directory entries, counting every entry; drops each record file whose modification time is more than 24 hours plus a few seconds of clock skew old without reading it; and parses at most 1024 of the rest, newest first. Both bounds are 1024, so a heavy day of ordinary records never reaches them: overflow means more than 1024 entries in `.gsd/dispatch-isolation`.
- `.gsd` or `.gsd/dispatch-isolation` exists but is a link, is not a directory, or cannot be read. A directory that does not exist is simply empty, not an overflow.
- A recent file in `.gsd/dispatch-isolation` (modified within the last 24 hours plus clock skew) that the reader refuses or rejects: a `.json` file (the suffix is matched case-insensitively, so `.JSON` counts too) that is unreadable, hard-linked, a link, oversize, malformed or truncated JSON, or whose contents disagree with its filename. The same applies to a legacy `.gsd/dispatch-isolation-sentinel.json` that exists and is recent but cannot be used (a missing one is simply absent). Such a file might name a type, so it cannot be ruled out. Non-`.json` entries, directories and files older than 24 hours are ignored.
- Any recent record has `executor_types_truncated: true`: names were dropped, either by the writer to fit the record or by the reader because the record lists more than 64 valid entries, so its list cannot rule a type out.
- A recent record whose `written_at` is more than the clock-skew allowance in the future: it cannot be classed as recent, yet it may name a type, so it is treated as unusable.

While any of these holds, every valid non-GSD-role agent, host built-ins such as `Explore`, `general-purpose` and `Plan` included, is held to the worktree rule exactly as `gsd-executor` is, until the case clears. To recover, by case (record files are otherwise pruned after 24 hours):

- A legacy slot `.gsd/dispatch-isolation-sentinel.json` that is refused or malformed: remove it (or rewrite it as valid JSON).
- `.gsd` or `.gsd/dispatch-isolation` that is a link or any other non-directory: replace it with a real directory.
- A truncated record (more than 64 hinted executors in a phase or milestone, or names over the record's byte budget): shorten or reduce the `agent_hint` names; every phase- or milestone-level write rewrites the record, and the case clears 24 hours after the last write.
- A scan overflow (more than 1024 entries in `.gsd/dispatch-isolation`): remove stale entries from `.gsd/dispatch-isolation/` until 1024 or fewer remain, or remove the directory (it is recreated on the next write).
- An unreadable `.gsd` or `.gsd/dispatch-isolation` directory: restore read and execute permission on it.
- A recent keyed record file in `.gsd/dispatch-isolation/` that the reader refuses or rejects (malformed, wrong key, hard link, link, FIFO, device, unreadable (mode 000), no phase, oversize): remove it.
- A recent record whose `written_at` is in the future (beyond the clock-skew allowance), or a future-dated legacy slot: the legacy slot (`.gsd/dispatch-isolation-sentinel.json`) clears on the next dispatch-isolation write; a keyed file clears 24 hours after its mtime (the writer prunes it and the reader stops counting it) or when removed by hand.

The record and the marker each cover the other's gap: a prompt that lost its marker is still caught by the record, and a record that went stale is still covered by the marker.

### The trade-off

For up to 24 hours after any record names a specialist, ad-hoc use of that specialist anywhere in the project is also held to the worktree rule. Milestone-level records, written by `quick`, `quick-batch`, `diagnose-issues` and `execute-plan` without `--phase` or `--plan`, list every hinted specialist in the milestone, so they start that window for all of them. GSD accepts that because matching a prose prompt to a record by phase and plan proved unreliable: a prompt that says "phase 2" while the record says `02`, a prompt that names a phase but no plan, or a record that aged past the freshness window while its executor was still running all slipped a specialist through unguarded. Reading identity from the prompt is the fragile part, so classification stops doing it and asks only whether any recent record names the type.

## What stays the same

- `gsd-executor` is always treated as an executor, with or without a record.
- A dispatch with no marker and no recent record naming its type is not an executor, so ad-hoc use of a specialist outside `execute-phase` is unaffected, except in the 24 hours after a record names it or when one of the fail-closed cases applies (in which case every valid non-GSD-role agent, host built-ins such as `Explore` included, is held to the worktree rule until the case clears). Records from older GSD versions carry no executor names, so for those only the marker adds anything.
- Other agents (verifier, planner, researchers) are not guarded as executors: their prompts carry no marker and no record names them.

## Why GSD roles are refused as hints

`agent_hint: gsd-verifier` would make the verifier the plan's executor: it would write code, and it would be recorded and guarded as the executor. GSD's own roles have their own contracts, so routing refuses any GSD role other than `gsd-executor`, prints a warning, and uses `gsd-executor`. `record-dispatch-isolation --executor-type` refuses them the same way (it prints the warning and records no executor), and the reader never classifies a GSD role as an executor even when a hand-written record names one.

## The executor policy

Whether hints are honoured at all is a project setting, `workflow.agent_hint_routing`, asked as the **Executor** question by `/gsd-new-project` and `/gsd-settings` ([how to choose it](../how-to/choose-the-executor-policy.md)). It has two answers.

- **Allow installed executors**, the default. A plan's `agent_hint:` may name an executor agent installed on the active runtime, and that agent runs the plan. "Installed" means an agent file the runtime resolves; GSD's own non-executor roles are excluded ([see above](#why-gsd-roles-are-refused-as-hints)). A plan without a hint runs on `gsd-executor`, so for a project that never writes hints this answer changes nothing.
- **gsd-executor only**. Every plan runs on `gsd-executor` and hints are ignored. Choose it when plans may carry hints you do not want honoured, for example plans imported from another project, or when you want one executor contract for the whole project.

Allowing is the default because a hint is an explicit statement in a plan, and a routed executor is not a weaker executor: it is recorded and held to the same worktree isolation guard as `gsd-executor`, and its model is chosen as described next. The policy decides only who runs the plan, never whether the guard applies.

## Model and effort

A specialist is usually not in GSD's model catalog, and an uncatalogued agent would otherwise resolve to a generic profile default. So the specialist's model resolves from its own `model_overrides` entry when it has one, and otherwise from what `gsd-executor` would get. That keeps a cheap-executor profile cheap for specialists too. Effort is left to the specialist's own frontmatter. A `gsd-executor` effort fallback is tracked separately in #5330.

## The orchestrator-worktree backend

The `orchestrator-worktree` backend starts executors as processes, not `Agent()` calls, so it has no `subagent_type` to route. It always runs `gsd-executor`, and it says so when a plan has a hint.
