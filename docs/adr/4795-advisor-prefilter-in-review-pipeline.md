# ADR-4795: Advisor pre-filter in the review pipeline — a same-context consult before the cold-subagent gates

- **Status:** Proposed
- **Date:** 2026-11-26
- **Issue:** [#4795](https://github.com/open-gsd/gsd-core/issues/4795)
- **Implementation:** `capabilities/advisor-prefilter/capability.json`, `commands/gsd/advisor-prefilter.md`
- **Extends:** [ADR-857](857-capability-system.md) (steps dispatched through the loop-hook seam) · [ADR-894](894-capability-declaration-format.md) (a `role: "feature"` manifest that owns a skill stem and three `steps`)

## Context

Four gates spawn a cold subagent to review in-progress work: the plan-checker loop, the code-review gate, `gsd-verifier` and `gsd-security-auditor`. A cold subagent re-derives context from the repository at spawn time and sees nothing of the session. When source changes after its pass but before the next lifecycle step, nothing asks whether that review still applies to the current output, and a phase, a PR or an external reviewer can consume a review of content that has since changed.

Claude Code can pair the session's executor with a stronger advisor model that reads the whole transcript. `gsd-core/references/model-profiles.md` documents that subagents inherit it, but no GSD gate consults it.

## Decision

**D1 — An optional first-party capability, not a new hook kind.** `advisor-prefilter` is a `role: "feature"` capability, `workflow.advisor_prefilter`, default **off**. The published `loop render-hooks` envelope stays byte-identical for every existing consumer (Hyrum). The triage review of #4795 reached the same verdict.

**D2 — A `step` with `ref.skill`, at `execute:wave:post`, `verify:post` and `ship:pre`.** The advisor is a host tool the model calls; a subprocess cannot reach it, which rules out `ref.command`. A `contribution` fits only the points that publish the `orchestrator` role (discuss, verify, ship); `execute:*` publishes `executor`, `verifier` and `code-reviewer` and the registry build would refuse it. A skill step runs in the orchestrator's context at all three points, and the three host workflows already dispatch every active `step`, so no workflow or validator is edited.

**D3 — The no-op signal is the tool being present.** The skill returns silently when the session has no advisor tool. It does not read host settings (`advisorModel`), which would couple core to a host-private file.

**D4 — Advisory by construction.** The step never blocks, edits, spawns a subagent or re-runs a reviewer; `onError: skip`. Its answer is text for the reviewers that follow. It does not replace any reviewer or any cross-AI lane (Goodhart: it must not become a gate input).

## Alternatives rejected

- **A new `advisor-check` hook kind** — changes the published envelope; the contract does not specify how host loops treat an unknown kind.
- **`step` + `ref.command` (`gsd_run advisor-check`)** — only a deterministic stale-sha check would remain, which is a different feature and adds a CLI module with its full ripple.
- **Replace the cold-subagent gates with the advisor** — the advisor has no per-agent role specialisation (anthropics/claude-code#73072) and is correlated with the executor.
- **Route through `/gsd-plan-review-convergence`** — that mechanism exists for decorrelated cross-AI arbitration; a same-family advisor is not that.

## Consequences

- Every enabled consult sends the full transcript to the advisor model, billed at the advisor's rate; the key is off by default and the how-to states the cost.
- Non-Claude-Code runtimes get a silent no-op.
- The plan-checker loop is not hooked: `plan:post` publishes `planner` and `checker`, and the issue's proposed points exclude it.
- The Claude Code advisor interface is experimental upstream; drift is a standing maintenance tail, bounded by taking no dependency beyond tool presence.
