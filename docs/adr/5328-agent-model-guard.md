# ADR-5328: The Agent() Model Guard Rides the Isolation Guard, Recomputes Its Baseline, and Accepts a Bounded Escalation Record

- **Status:** Accepted (2026-10-18)
- **Date:** 2026-10-17
- **Issue:** [#5328](https://github.com/open-gsd/gsd-core/issues/5328) — `enhancement`, `approved-enhancement`
- **Builds on:** [ADR-4630](4630-dispatch-identity-and-isolation-decision-seam.md) (one owner of the dispatch decision), [ADR-3473](3473-enforcement-by-construction.md) (one owner per invariant)
- **Scope note:** issue triage asked for the design to be agreed on the PR before building. A maintainer accepted this ADR as written on [PR #5413](https://github.com/open-gsd/gsd-core/pull/5413) (review of head `07463dffa0`, 2026-10-18).

## Context

`init.*` resolves a model per agent (`resolveModelInternal`) and the workflows tell the orchestrator to pass it to `Agent()`. Nothing compares the model-authored `Agent()` argument with the resolver's answer, so an orchestrator can silently run `gsd-executor` on a different tier than the one configured.

## Decision

### Decision 1 — the check lives in the existing PreToolUse isolation guard

`hooks/gsd-agent-isolation-guard.js` already sees every `Agent()`/`Task()` dispatch on every runtime and is already registered; a second hook would be a second owner of the same dispatch. `evaluateDispatch` runs the isolation verdict first (a block always wins) and then `checkAgentModel` (`hooks/lib/agent-model-check.js`).

### Decision 2 — the baseline is recomputed at dispatch, not persisted next to the isolation sentinel

The issue suggested persisting resolved models when `init.*` runs. A persisted copy goes stale the moment `model_profile`, `model_overrides` or `dynamic_routing` changes; recomputing from `resolveModelInternal` cannot. The cost is a resolver load in the hook. The check passes its build seam `ensureRuntimeBuild({ tscScript: null })`, so on a cold tree it skips (allows) instead of compiling inside the hook, and never fails closed. This holds for the model check only: on a `gsd-executor` dispatch the isolation path of the same hook still runs the full `ensureRuntimeBuild()` self-heal, unchanged by this ADR.

### Decision 3 — escalation is a single-slot, unauthenticated record bounded by a 10-minute window

`resolve-execution <agent> --attempt N` writes `.gsd/model-escalation-<agent>.json` when it resolves a model different from the baseline; the guard accepts that model for 10 minutes (`ESCALATION_WINDOW_MS`, `src/model-escalation.cts`, the one owner of the file shared by the CLI and the hook) and, when the record and the dispatch both carry a session id (`CLAUDE_CODE_SESSION_ID` / hook `session_id`), only in that session. That ties an escalation to the run that asked for it without a plan identity `resolve-execution` does not have. Nothing clears the record: a clear would let a sibling plan's baseline `--attempt 0` drop an in-flight escalation of the same agent type. The record is not authenticated, so it is defence in depth, not a security boundary.

### Decision 4 — warn by default; deny blocks a wrong model

`hooks.agent_model_guard`: `"warn"` (default), `"deny"`, `false`. Under `"deny"` a passed, wrong `model` blocks; an omitted `model` stays a warning, because the hook cannot see the orchestrator's model that the subagent would inherit, so it cannot tell that the omission differs. Every stock workflow spawn site passes `model=` with the resolved model, so an omission there is a hand-written dispatch. `mode` is read from the root config only (like the other `hooks.*` keys); the runtime comes from the workstream-aware `loadConfig`, the same result the expected model resolves through. Runtime gating reads the descriptor fact `hostBehaviors.nativeModelAliases` over the one runtime chain (`resolveActiveRuntime`: `GSD_RUNTIME` > `config.runtime` > install marker), never a runtime-name literal (ADR-5057 §5).

## Alternatives rejected

- **A new hook.** Two owners of the dispatch decision (ADR-4630, ADR-3473).
- **Persist the baseline at `init` time.** Goes stale; needs invalidation on every config write.
- **Per-plan escalation keys.** `resolve-execution` has no plan identity today; the session id gives "same run" without a new argument.

## Consequences

- A default-on warning for every Claude Code user with a `.planning/config.json`.
- `resolve-execution` gains a write side effect, only for an escalated model.
- The guard is Claude-only.
