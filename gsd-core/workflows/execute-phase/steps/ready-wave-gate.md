# Ready-wave gate (#4628)

Read and follow this fragment from `execute-phase.md` step 1
(`discover_and_group_plans`). It owns the #4628 readiness rules so the host
stays inside its ADR-857 Phase 6 byte budget (#1168).

`phase-plan-index` now exposes, additively: `ready_plans` (top level), and —
on every INCOMPLETE plan — `ready` plus `unresolved_dependencies`. `runnable`
keeps its #2830 meaning ("not halted-blocked") and says nothing about
completion evidence: a runnable plan whose dependencies lack a SUMMARY is not
DAG-ready.

**Named skip (#4628):** additionally skip any incomplete plan whose `ready` is
`false` — it has direct dependencies without completion evidence, and
dispatching it would violate the declared DAG — and report it by name with the
missing predecessors: "Skipping {plan.id}: incomplete predecessor
{unresolved_dependencies.join(', ')}". Readiness is transitive: a ready
plan's own dependencies are already complete, so **a not-ready plan must
never be dispatched in this run, even when a later wave's plans are ready**.

**Waiting is not done (#4628).** In step 1's filtered-out evaluation order,
after the #2830 blocked condition and before the all-summarized condition,
insert:

> 2b. **No filter is active, no blocked-plan skip occurred, and at least one
> filtered plan was skipped because `ready: false` (#4624 cross-reference; #4628 scope)** — the wave
> is WAITING on incomplete predecessors, not finished: report "Phase waiting:
> {plan ids} await incomplete predecessors {unresolved_dependencies} —
> dispatch the ready wave, then re-run." → exit. Do not fall through to the
> completion states; nothing here is a completion state. (The ready plans
> themselves were already dispatched this run — the executor wave loop
> dispatches every ready plan of the earliest ready wave onward.)

This ordering is fail-closed: a later wave is never selected while any
predecessor is incomplete, because a ready plan's own dependencies are
complete by construction — anything not ready is reported and the run stops
at the waiting condition.
