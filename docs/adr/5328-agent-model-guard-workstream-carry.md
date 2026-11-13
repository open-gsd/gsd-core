# ADR-5328: The Agent model guard compares against the workstream `init --ws` selected

- **Status:** Proposed
- **Date:** 2026-11-02
- **Issue:** [#5328](https://github.com/open-gsd/gsd-core/issues/5328), PR [#5413](https://github.com/open-gsd/gsd-core/pull/5413)
- **Builds on:** [ADR-5328](5328-agent-model-guard.md) (Decision 2: the baseline is recomputed at dispatch, never persisted as a model)

## Context

The workflows select a workstream with `--ws` on the `init` call (`gsd-core/workflows/execute-phase.md`). The PreToolUse hook never sees that flag, so it resolved the baseline from `GSD_WORKSTREAM` and the stored pointer only, and a dispatch on the model `init` reported for that workstream was warned, or blocked under `"deny"`.

## Decision

1. `init` invoked with `--ws` on its command line records that workstream name and the time it was written, session-scoped beside the active-workstream pointer files (`recordInitWorkstream`, `src/active-workstream-store.cts`), keyed by `CLAUDE_CODE_SESSION_ID`, and only where the guard applies (`guardApplies`: Claude Code, guard not off). An `init` without the flag never writes an entry and never clears one; no other command writes it. With no session id nothing is recorded. A session keeps its newest `INIT_WORKSTREAM_MAX_ENTRIES` workstreams, one line each, so a read-only `init --ws beta` does not displace the `alpha` of the run in progress; naming a workstream again refreshes its line. A line counts for 12 hours (`INIT_WORKSTREAM_MAX_AGE_MS`), longer than one execute-phase run.
2. The guard's baseline is the set {every workstream recorded for the dispatch's `session_id`, the `GSD_WORKSTREAM`/pointer resolution}. A dispatch passes when its model matches any of them at tier level, or when an escalation record allows it; a mismatch names every model in the set.
3. When the project has workstreams and the dispatch carries no session id, the guard cannot establish the workstream `init` used, and allows. The same holds for a session whose carry holds a line older than 12 hours, or no parseable line: the run that line stands for may still dispatch, so the guard allows instead of denying a workstream it cannot tell apart. A record keeps expired lines until they pass 7 days (`INIT_WORKSTREAM_PRUNE_AGE_MS`). Every `init` where the guard applies sweeps this project's carry files that hold no readable line from the last 7 days (an empty, unreadable or oversized file included).
4. Nothing is persisted but a workstream name. Models are recomputed at dispatch, as ADR-5328 Decision 2 requires.
5. `.gsd/.gitignore` has one owner, `ensureToolOwnedGsdDir` (`src/gsd-tool-dir.cts`, #5757). The escalation-record writer (`writeEscalation`, `src/model-escalation.cts`) calls it with its own marker and rules, as the dispatch-sentinel writer and the fork-probe cache do, so no second copy of the directory checks or the ignore merge exists. The owner's open of an existing `.gsd/.gitignore` has no `O_NONBLOCK`: a FIFO there blocks every caller, tracked as [#5857](https://github.com/open-gsd/gsd-core/issues/5857) and out of this ADR.

## Alternatives rejected

- **Workflow markers.** Workflow prose is out of this enhancement's scope.
- **Persist the resolved model at `init` time.** Goes stale (ADR-5328 Decision 2).
- **Write the active-workstream pointer on `--ws`.** Changes the workstream of every later command.
- **Allow every dispatch when workstreams exist.** Leaves wrong-tier dispatches in workstream projects unflagged.

## Consequences

- `init --ws` gains a write side effect where the guard applies: one small file under the OS temp directory per session and project.
- A line expires 12 hours after the `init --ws` that wrote it. While a carry holds an expired line, the hook allows every dispatch of that session. An unflagged `init` writes and clears no entry.
- The carry is read through the bounded regular-file reader (a FIFO, a device or a file over `INIT_WORKSTREAM_MAX_BYTES`, the size of eight entries at their longest, reads as no carry) but not with `O_NOFOLLOW`. The session pointer files beside it in `os.tmpdir()` share that exposure; a planted link can only widen the accepted set by names, and the carry is not a security boundary.
