# ADR-5328: The Agent model guard compares against the workstream `init --ws` selected

- **Status:** Proposed
- **Date:** 2026-11-02
- **Issue:** [#5328](https://github.com/open-gsd/gsd-core/issues/5328), PR [#5413](https://github.com/open-gsd/gsd-core/pull/5413)
- **Builds on:** [ADR-5328](5328-agent-model-guard.md) (Decision 2: the baseline is recomputed at dispatch, never persisted as a model)

## Context

The workflows select a workstream with `--ws` on the `init` call (`gsd-core/workflows/execute-phase.md`). The PreToolUse hook never sees that flag, so it resolved the baseline from `GSD_WORKSTREAM` and the stored pointer only, and a dispatch on the model `init` reported for that workstream was warned, or blocked under `"deny"`.

## Decision

1. `init` invoked with `--ws` on its command line records that workstream name and the time it was written, session-scoped beside the active-workstream pointer files (`recordInitWorkstream`, `src/active-workstream-store.cts`), keyed by `CLAUDE_CODE_SESSION_ID`. An `init` without the flag never writes and never clears it; no other command writes it. With no session id nothing is recorded. A record counts for 10 minutes (`ESCALATION_WINDOW_MS`, the escalation record's window); every `init --ws` refreshes it and prunes this project's expired records.
2. The guard's baseline is the set {the recorded workstream for the dispatch's `session_id`, the `GSD_WORKSTREAM`/pointer resolution}. A dispatch passes when its model matches either at tier level, or when an escalation record allows it; a mismatch reports the recorded workstream's model.
3. When the project has workstreams and the dispatch carries no session id, the guard cannot establish the workstream `init` used, and allows.
4. Nothing is persisted but a workstream name. Models are recomputed at dispatch, as ADR-5328 Decision 2 requires.
5. `.gsd/.gitignore` upkeep: the dispatch-sentinel writer's policy (`gsd-core/bin/gsd-tools.cjs`, `writeDispatchIsolationSentinel`) is the rule, the escalation-record writer (`writeEscalation`, `src/model-escalation.cts`) mirrors it, and a parity test pins the two.

## Alternatives rejected

- **Workflow markers.** Workflow prose is out of this enhancement's scope.
- **Persist the resolved model at `init` time.** Goes stale (ADR-5328 Decision 2).
- **Write the active-workstream pointer on `--ws`.** Changes the workstream of every later command.
- **Allow every dispatch when workstreams exist.** Leaves wrong-tier dispatches in workstream projects unflagged.

## Consequences

- `init --ws` gains a write side effect: one small file under the OS temp directory per session and project.
- A record expires 10 minutes after the last `init --ws` that wrote it, so an earlier workstream stops widening the accepted set once that window passes; an unflagged `init` neither writes nor clears it.
