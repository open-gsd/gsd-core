# ADR-4630: One Canonical Dispatch-Identity Owner and a Recorded Isolation Decision

- **Status:** Accepted
- **Date:** 2026-09-13
- **Issue:** [#4630](https://github.com/open-gsd/gsd-core/issues/4630) — epic (`type: chore`, `area: agents`)
- **Absorbs:** [#4222](https://github.com/open-gsd/gsd-core/issues/4222), [#4561](https://github.com/open-gsd/gsd-core/issues/4561), [#4594](https://github.com/open-gsd/gsd-core/issues/4594) — three `confirmed-bug` issues that are the same missing owner reported at two ends of one wire
- **Framed by:** [ADR-1239](1239-gsd-embeddable-orchestration-engine.md) (host-integration interface — agent dispatch is interface point 2)
- **Pattern copied from:** [ADR-2121](2121-phase-identifier-parsing-consolidation.md) (phase-identifier consolidation: seam + migration + anti-divergence guard). This ADR reuses its phase-token grammar and its drift-lint shape deliberately.
- **Scope note:** unlike ADR-2121, this ADR does **not** land as a code-free Phase 0. It ships alongside Phase 1's implementation because the epic's phase sub-issues could not be created in the session that executed it; the decisions below were nonetheless fixed before that implementation was written, and Phases 2 and 3 execute against this file.

## Context

A GSD phase execution decides, per dispatch, whether the executor runs isolated in a git
worktree or sequentially in the primary checkout. That decision is:

1. **produced** in workflow shell (`execute-phase/steps/executor-isolation-dispatch.md`, `per-plan-worktree-gate.md`, `references/dispatch-isolation-gate.md`, `execute-plan.md`),
2. **transported** through a run-scoped sentinel at `.gsd/dispatch-isolation-sentinel.json`,
3. **consumed** by two guard hooks (`hooks/gsd-agent-isolation-guard.js` for Claude-shaped hosts, `hooks/gsd-cursor-subagent-start.js` for Cursor).

At every hop, both sides hand-roll their own copy of the format. #4561 states the census
directly: the dispatch-isolation membership is **hand-written at eight uncross-checked
sites**. The consequence is not a style complaint — it is three confirmed bugs:

| Issue | Defect |
|---|---|
| #4222 | A plain `dispatch-isolation` re-query re-resolves the host *capability* and re-persists it, clobbering every shell-computed degrade but the #3737 opt-out. The guard then denies the mandated sequential dispatch with `exit 2`. |
| #4561 | #4232's re-derivation fix reaches only producers whose degrade is re-derivable from a file the resolver reads. Three producers compute their degrade from call-site context that is **not on disk** and are structurally unreachable that way. |
| #4594 | `extractDispatchIdentifiers` cannot parse the canonical prompt-body dispatch text, so the sentinel match never succeeds. |

### What #4594 actually is, measured

The reported symptom is a greedy capture: `/execute\s+plan\s+(\S+)\s+of\s+phase\s+(\S+)/i`
swallows the `-{phase_name}` suffix and the sentence-terminating period, so
`Execute plan 02 of phase 03-auth.` yields phase `03-auth.` and can never equal the
sentinel's `03`.

That is true and incomplete. Running `phase-plan-index` against a real fixture shows
`plans[].id` is `03-02-hardening` — phase-prefixed, plan-numbered **and slugged** — and
`per-plan-worktree-gate.md:17` records exactly that value as the sentinel's `plan`. The
prose, meanwhile, carries a bare in-phase plan number (`02`). The two fields therefore live
in **different namespaces**, and the plan comparison mismatches on *every* dispatch, on
*both* hosts. The issue calls the Claude path "latent rather than dead"; it is dead too, for
a second reason the issue does not name. Fixing only the greedy capture would have shipped
as a green, fully-tested no-op.

### Why this recurs rather than staying fixed

Repairing each symptom where it was reported leaves the missing owner missing, and the next
occurrence is already being written elsewhere in the tree. The recurrence has a mechanical
root, and it is the same one ADR-2121 identified for phase identifiers: **a format with no
single owner is re-derived at each site, and two copies that agree today are the same defect
as two that disagree.**

## Decision

### Decision 1 — one module owns the emitted format *and* the parser that reads it back

`hooks/lib/dispatch-identity.js` owns both halves together:

- `renderDispatchIdentityMarker({phase, plan})` — the format producers emit.
- `parseDispatchIdentity(...texts)` — the pattern consumers read back.

Producers emit a structured marker carrying the **same shell values the sentinel records**:

```text
[gsd:dispatch phase="03" plan="03-02-hardening"]
```

`$PHASE_NUMBER` and `$plan_id` are already in scope at every producer site. Producer and
consumer then agree *by construction*, independently of how the surrounding prose reads or
whether a model paraphrases it.

The prose frame remains as a fallback, with the greedy `(\S+)` replaced by the phase-token
grammar ADR-2121 already owns, and with `plan` deliberately **not** reported — the prose
plan token is a different namespace from `plan_id`, and reporting it is the bug. The
fallback is therefore **correct-or-absent** in both fields: an absent identifier means
"cannot compare" and is safe by the existing contract; a wrong one is a false mismatch and
is not.

**The owner lives in `hooks/lib/`, not `src/`.** The guard hooks must load on a raw
plugin-marketplace install where the compiled `gsd-core/bin/lib/` is absent and the
self-healing build seam has not run — a hook that dies at module load is worse than one
carrying a mirror. A `src/*.cts` owner would force either a top-level require of the
compiled lib (breaking that install) or a second mirrored copy (the exact defect this epic
removes). Nothing in `src/**` needs this format: the producers are workflow *markdown* and
the consumers are *hooks*.

### Decision 2 — the isolation decision is a recorded fact, not a re-derived one

A producer writes an `IsolationDecision` (the value, which producer decided it, and its run
scope); consumers **read** it. A plain re-query must not overwrite a recorded decision.

Re-derivation is the wrong primitive for the three producers #4561 names, because each
computes its degrade from call-site context that does not exist on disk:

| Producer | Why re-derivation cannot reach it |
|---|---|
| `gsd-core/references/dispatch-isolation-gate.md` | the `orchestrator-worktree` fallback fires only at a subagent-tool-only dispatch site; the resolver cannot see which tool the caller has |
| `gsd-core/workflows/execute-phase/steps/per-plan-worktree-gate.md` | the #2474 per-plan submodule intersection is a property of the plan set, not the repo |
| `gsd-core/workflows/execute-plan.md` | Pattern B's unisolated segments are by design; which segment is executing is not on disk |

**A decision that cannot be recomputed must be recorded and honoured, not recomputed and
overwritten.** #4232's base-check re-derivation stays — it is correct for the producers it
covers, and this decision builds on it rather than replacing it.

### Decision 3 — a copy that must exist is pinned by a parity test, never merely tolerated

Decision 1's cold-load constraint means `hooks/lib/` carries deliberate mirrors of two
things it cannot import: the phase-token grammar (from `src/phase-id.cts`) and the isolation
vocabulary (from the Phase 2 owner). Each mirror is **pinned by a parity assertion that reds
when the owner changes**.

This matters more than it looks. A drifted grammar mirror fails as a **non-match** — nothing
throws, no test that only feeds the old shape notices, and the symptom is a guard that
quietly stops recognizing valid input. That is the failure mode that produced #4594 and it
is invisible without a pin.

A mirror's justification is part of the contract: **do not "clean up" a pinned mirror
without replacing the reason it exists.**

### Decision 4 — the anti-divergence lint is part of the deliverable, not a follow-up

A drift lint asserts that (a) every dispatch-identifier template in
`gsd-core/workflows/**/*.md` and every parsing regex in `hooks/**` derives from the single
exported token source, and (b) every dispatch-isolation producer site appears in the
canonical membership list. It is modelled on `scripts/lint-phase-id-drift.cjs`.

Two lessons from #2121 are binding:

- Compare the regex derived from the **source string** (`.source` / `.flags` against the
  canonical token), not the rendered literal.
- A sanctioned exemption is a **dedicated comment line** that states which half is
  deliberate — never a line-level substring escape. Partial ownership is drift, and a
  line-level escape waves through exactly the case under review.

Decisions 1 and 2 without Decision 4 un-consolidate quietly as soon as someone who has not
read this ADR touches the area. **The lint must be demonstrated red before it is
demonstrated green** — a drift guard that has never failed is not evidence.

### Decision 5 — an inapplicable sentinel is reported, never silently discarded

When a fresh sentinel exists but does not apply to a dispatch, the guard states so in its
deny reason and names both sides' identifiers.

This is Postel's Law's "be liberal but *visible*" half, and its absence is why the defect
survived three producers and two consumers unnoticed: the guard discarded a fresh sentinel
and then denied with a message about registry resolution that never mentioned the sentinel
existed. Values interpolated into that message come from a sentinel file and from
model-authored prompt text — both untrusted — so each is length-bounded and stripped of
control characters first, matching the escaping discipline `phase-plan-index` already
applies to a `depends_on` token.

## Alternatives rejected

1. **Repair the three absorbed issues at their existing call sites.** This is the pattern
   that produced them. It leaves the epic open with every symptom gone and CI green — the
   specific outcome the epic's scoping exists to prevent.
2. **Normalize the plan comparison** — strip the phase prefix and slug and compare the
   middle segment. Invents a cross-namespace equivalence no producer guarantees, and
   silently restores wrong-value-instead-of-no-value the moment plan-id naming changes.
   Returning `null` is honest; a heuristic match is not.
3. **Carry a structured per-dispatch kwarg through the Agent/Task protocol.** This is the
   correct end state and `hooks/lib/isolation-sentinel.js` has named it as such since #3045.
   Rejected *for now* under Gall's Law: it is a 19-runtime descriptor change and an
   ADR-1239-level negotiation change. The marker is the simple version that works, and
   growing one into the other is the sanctioned path.
4. **Own the format in `src/dispatch-identity.cts`.** Breaks the cold-tree hook load
   contract, or forces the second mirror this epic exists to delete.
5. **Delete `sentinelAppliesToDispatch`'s plan/phase narrowing**, on the grounds that it has
   never worked so removing it changes nothing observable. It is #3045 SECURITY F2's defence
   against a stale sentinel from an earlier phase authorizing a later dispatch. The marker
   makes it work for the first time; deleting it would trade one silent hole for another.

## Consequences

**Accepted cost.** `[gsd:dispatch k="v"]` is a homegrown key/value mini-syntax, and
Greenspun's Tenth Rule is the standing warning against letting one grow. It is therefore
deliberately inert: exactly two recognized keys, flat, no nesting, no conditionals, no
variables, no escaping rules beyond quoted values, and unrecognized keys ignored so a later
addition cannot break a deployed parser. **Revisit condition, stated so it is actionable:
the moment this marker needs a third semantic key or any structure, stop and implement
alternative 3 instead.**

**Accepted limit.** The marker is emitted by a model following a template on BOTH paths —
the harness path AND the orchestrator-worktree path. Per
`executor-isolation-dispatch.md:131`, the orchestrator-worktree path's `{plan_number}` and
`{phase_number}` "are template placeholders, not shell variables," and `{plan_id}` is
model-substituted there exactly as on the harness path — there is no shell-built prompt on
either path, so the marker is NOT guaranteed on either. A model that drops it degrades to
the prose fallback everywhere. That fallback is now correct-or-absent, which is sufficient
to resolve #4594 on the phase field alone, but plan-level scoping is exact only when the
marker survives. The prose fallback is therefore the real floor on both paths.

**Hyrum's Law constraint.** The prose sentence `Execute plan X of phase Y` is read by the
executor agent itself, not only by the guards. It stays **byte-identical**; the marker is
purely additive. Any future change to that sentence is a behavior change to every executor
dispatch, not a formatting edit.

**Out of scope.** The sentinel remains a `cwd`-derived, gitignored file; #3045 SECURITY F3's
accepted forgery risk is unchanged. This ADR changes how the decision is transported, not
when a degrade should occur.

## Phase mapping

| Phase | Delivers | Decisions |
|---|---|---|
| 1 | `hooks/lib/dispatch-identity.js`; producers emit the marker; both guards parse through the owner; #4594 regression | 1, 3 (grammar mirror), 5 |
| 2 | Isolation-vocabulary owner; recorded `IsolationDecision` that a re-query holds; #4222 / #4561 regressions | 2, 3 (vocabulary mirror) |
| 3 | `scripts/lint-dispatch-identity-drift.cjs`, demonstrated red then green | 4 |

Each deliverable is claimed by exactly one phase. The epic stays open until Phase 3 lands.
