# ADR-4795: Advisor pre-filter in the review pipeline — a same-context consult before the cold-subagent gates

- **Status:** Proposed
- **Date:** 2026-11-26
- **Issue:** [#4795](https://github.com/open-gsd/gsd-core/issues/4795)
- **Implementation:** `capabilities/advisor-prefilter/capability.json`, `capabilities/advisor-prefilter/fragments/advisor-prefilter.md`, contribution dispatch lines in `gsd-core/workflows/verify-work.md` and `gsd-core/workflows/ship.md`, and the string-switch reading in `src/capability-activation.cts`
- **Extends:** [ADR-857](857-capability-system.md) (contributions delivered through the loop-hook seam) · [ADR-894](894-capability-declaration-format.md) (a `role: "feature"` manifest with two `contributions`)

## Context

Four gates spawn a cold subagent to review in-progress work: the plan-checker loop, the code-review gate, `gsd-verifier` and `gsd-security-auditor`. A cold subagent re-derives context from the repository at spawn time and sees nothing of the session. When source changes after its pass but before the next lifecycle step, nothing asks whether that review still applies to the current output, and a phase, a PR or an external reviewer can consume a review of content that has since changed.

Claude Code can pair the session's executor with a stronger advisor model that reads the whole transcript. `gsd-core/references/model-profiles.md` documents that subagents inherit it, but no GSD gate consults it.

## Decision

**D1 — An optional first-party capability, not a new hook kind.** `advisor-prefilter` is a `role: "feature"` capability, `workflow.advisor_prefilter`, default **off**. The published `loop render-hooks` envelope stays byte-identical for every existing consumer (Hyrum). The triage review of #4795 reached the same verdict.

**D2 — A `contribution` `into: orchestrator` at `verify:post` and `ship:pre`.** The advisor is a host tool the orchestrator model calls, so the consult has to be an instruction in the orchestrator's own context; a subprocess (`ref.command`) cannot reach it. `orchestrator` is published only for discuss, verify and ship (`gsd-core/bin/lib/loop-host-contract.cjs`), so `execute:wave:post` cannot carry it, and the registry build refuses a contribution there. Those two points are the ones left.

**D3 — The workflows dispatch it.** Only `verify:pre` dispatched orchestrator contributions before this change. `verify-work.md` and `ship.md` each gain one dispatch line at `verify:post` and `ship:pre`; without it the fragment would install and never be delivered. A text contract pins both lines.

**D4 — The no-op signal is the tool being present.** The fragment tells the orchestrator to skip silently when the session has no advisor tool. It does not read host settings (`advisorModel`), which would couple core to a host-private file.

**D5 — Advisory by construction.** The consult never blocks, edits, spawns a subagent or re-runs a reviewer; `onError: skip`. Its answer is text for the reviewers that follow. It does not replace any reviewer or any cross-AI lane (Goodhart: it must not become a gate input).

**D6 — A string switch is read for its meaning.** `_resolveActivationValue` used `Boolean(value)`, so a hand-edited `"false"` turned a capability on. Empty, `"false"`, `"0"`, `"no"` and `"off"` (any case, trimmed) now read as off for every capability switch; every other string stays on, and non-strings keep plain truthiness. Found while testing this capability and fixed here because the defect sits under every capability gate.

## Alternatives rejected

- **A new `advisor-check` hook kind** — changes the published envelope; the contract does not specify how host loops treat an unknown kind.
- **`step` + `ref.command` (`gsd_run advisor-check`)** — only a deterministic stale-sha check would remain, which is a different feature and adds a CLI module with its full ripple.
- **`step` + `ref.skill` with an owned skill, at `execute:wave:post`, `verify:post` and `ship:pre`** — built first and reversed: every capability skill is a user-invocable command, and the new command tripped the skill-count ratchet in `tests/skill-frontmatter-contract.test.cjs` ("fix at the source; do not just add to the allowlist"), help.md parity, the namespace routers and the MCP prompt count. The owner chose the contribution over an allowlist exception.
- **Replace the cold-subagent gates with the advisor** — the advisor has no per-agent role specialisation (anthropics/claude-code#73072) and is correlated with the executor.
- **Route through `/gsd-plan-review-convergence`** — that mechanism exists for decorrelated cross-AI arbitration; a same-family advisor is not that.

## Consequences

- Every enabled consult sends the full transcript to the advisor model, billed at the advisor's rate; the key is off by default and the how-to states the cost.
- Non-Claude-Code runtimes get a silent no-op.
- `execute:wave:post` is not covered, so a wave's output is not pre-filtered; the phase output is checked at `verify:post`. The plan-checker loop is not hooked either: `plan:post` publishes `planner` and `checker`.
- `secure-phase` needs no call site of its own: it is itself a `verify:post` step, so the `verify:post` consult already covers its point.
- The no-op is an instruction the model follows, not a check a test can run; the behavioral tests pin the manifest, registry, dispatch and string-switch contract, and a text contract pins the fragment and the two dispatch lines.
- Whether the orchestrator model exposes the advisor tool in a given host is host behavior this repository cannot assert; the fragment's silent no-op covers the case where it does not.
- The Claude Code advisor interface is experimental upstream; drift is a standing maintenance tail, bounded by taking no dependency beyond tool presence.
- The string-switch reading changes the result only for a string config value: a `"false"` that used to enable a capability now disables it.
