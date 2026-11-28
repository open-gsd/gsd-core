---
id: 144
title: Spec-Phase Edge-Completeness Probe
group: v1.42.1 Features
---

**Command:** `/gsd-spec-phase`

**Purpose:** Surface the omitted domain-boundary edges that silently invalidate a requirement — touching intervals, empty inputs, rounding ties, grapheme truncation — before they become production defects. Runs as `Step 5.5` of spec-phase, after the ambiguity gate.

**Behavior:** For each SPEC requirement the probe classifies its data/behavior shape, then raises only the *applicable* categories from a closed 8-category taxonomy (boundary, adjacency, empty, encoding, ordering, precision, idempotency, concurrency) via a relevance filter. Each raised category proposes one concrete candidate edge, which the author resolves to exactly one of four states:

| State | Meaning | Downstream effect |
|-------|---------|-------------------|
| `covered` | An acceptance criterion handles the edge | Pass/fail line written into the SPEC Acceptance Criteria block; lifted into `plan-phase` `must_haves.truths` |
| `dismissed` | The edge cannot occur (requires a non-empty reason) | Recorded with its reason; empty dismissals are rejected |
| `backstop` | Intent recorded, needs a held-out/property-based test | Lifted into `must_haves.truths` as a non-inferable check |
| `unresolved` | Deferred | Soft-gates the spec; row stamped `⚠ Edge unresolved — planner must treat as assumption` |

A requirement whose prose matches **no** shape cue is surfaced as a single `unclassified — review manually` candidate, never silently dropped (#1110). A project with `response_language` set gets an optional `text_en` English translation per requirement as engine input only (#2773, #3717); the SPEC keeps its own language. The reasoning is in [Spec-phase probes: edge and prohibition design](../explanation/spec-phase-probe-design.md#edge-probe).

The resolved edges populate a `## Edge Coverage` section in `SPEC.md`. Unresolved *applicable* edges trigger a soft gate (Resolve / Write-anyway-flagged / Keep-probing) rather than a hard block. Under `--auto`, the probe **never auto-dismisses** — it auto-covers where a defensible criterion exists, otherwise auto-backstops, and logs `[auto] edge coverage: C covered, B backstop, U unresolved`. The one exception is an `unclassified` candidate: `--auto` leaves it **`unresolved`** (surfaced as a flagged assumption), never auto-`backstop` — a missing shape is not evidence an edge exists, so minting a held-out edge obligation would be a false claim.

`plan-phase` lifts `covered` and `backstop` edges into `must_haves.truths`; a `backstop` edge becomes a structured non-inferable marker (`{ statement, verification: backstop }`). At verify time a `backstop` truth without explicit evidence (a passing wired held-out/property-based test, or a directly-observed behavior) abstains → `human_needed` with reason `insufficient_spec` (`unverified — held-out test recommended`), never a silent `passed` (#1154). An inferable truth is never abstained. Reference: [Honest Verifier](../../gsd-core/references/honest-verifier.md).

**Requirements:**
- REQ-EDGE-01: The edge pass MUST run after the ambiguity gate and emit a `## Edge Coverage` SPEC section.
- REQ-EDGE-02: The relevance filter MUST raise only applicable categories; each raised edge resolves to exactly one of covered/dismissed/backstop/unresolved.
- REQ-EDGE-03: A `dismissed` resolution MUST require a non-empty reason.
- REQ-EDGE-04: An unresolved applicable edge MUST trigger the soft gate; write-anyway stamps the row as a planner assumption.
- REQ-EDGE-05: `--auto` MUST never auto-dismiss — auto-cover or auto-backstop only.
- REQ-EDGE-06: `plan-phase` MUST lift `covered` criteria and `backstop` notes into `must_haves.truths`.
- REQ-EDGE-07: A requirement whose prose matches no shape cue MUST surface an `unclassified — review manually` candidate (never silently dropped); `--auto` MUST leave it `unresolved`, never auto-`backstop`.
- REQ-EDGE-08: `plan-phase` MUST lift a `backstop` edge into `must_haves.truths` as a structured flat-scalar marker (`{ statement, verification: backstop }`), never a prose parenthetical.
- REQ-HONEST-01: At verify time a `backstop` truth that cannot be confirmed with explicit evidence MUST abstain → `human_needed` (reason `insufficient_spec`), never `passed`; an inferable truth MUST never be abstained (over-abstention guard); abstention MUST be exogenous (driven by the `backstop` tag, not self-judgment).

**Reference:** [Edge Probe](../../gsd-core/references/edge-probe.md)
