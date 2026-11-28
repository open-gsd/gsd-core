# Spec-phase probes: edge and prohibition design

> Explanation. This page records why the two `/gsd-spec-phase` probes are built the way they
> are. What each probe does, its states and its requirements are in the
> [Edge-Completeness](../FEATURES.md) and [Prohibition](../FEATURES.md) feature entries; the
> agent-facing procedure is in [Edge Probe](../../gsd-core/references/edge-probe.md) and
> [Prohibition Probe](../../gsd-core/references/prohibition-probe.md).

## Edge probe

### Why an unclassified requirement is surfaced, not dropped (#1110)

When a requirement's prose matches no shape cue, the probe does not silently drop it. It emits
a single `unclassified — review manually` candidate so the zero-cue requirement is surfaced
for the author to resolve like any other (specify, dismiss-with-reason, defer) — a
manual-review nudge, not a hard block. Under `--auto` that candidate is left `unresolved`
(surfaced as a flagged assumption), never auto-`backstop`: a missing shape is not evidence an
edge exists, so minting a held-out edge obligation would be a false claim.

### Why the probe reads English via `text_en` (#2773, durable fix #3717)

The shape cues are English word-boundary patterns, so a project running with
[`response_language`](../CONFIGURATION.md) set would otherwise have every requirement match
nothing, classify to zero shapes, and land in `unclassified` — the taxonomy silently
contributing nothing to exactly the kind of spec it exists to harden. `spec-phase` Step 5.5
therefore populates an optional `text_en` field alongside each requirement's `text` with a
faithful English translation. `text_en` is engine input, never user-facing output, so it is
translated while `text` keeps the requirement's own wording (the SPEC stays in the original
language), requirement ids are left untouched, and any acceptance criteria written back from
the resolved edges return to `response_language`. Translation makes the classifier applicable;
it does not make it omniscient. A requirement carrying no shape cue in any language still
classifies to zero — that is the classifier's recorded recall gap (ADR-857 §98), not a
translation failure — and the remedy is the one an English project uses: author an explicit
`shapes` array on the requirement instead of relying on prose classification.

### Why a `backstop` edge is lifted as a structured marker, and why the verifier abstains (#1154)

The load-bearing wire is the `plan-phase` lift: `covered` and `backstop` edges become
`must_haves.truths` the verifier can check, so the section is not merely documentation. A
`backstop` edge is lifted as a structured non-inferable marker
(`{ statement, verification: backstop }`, a flat scalar — not a prose note), which the honest
verifier then consumes — closing the loop the edge-probe opened.

A non-inferable (`backstop`) truth is one whose correct behavior is not derivable from the
spec alone, so the verifier cannot self-detect the gap and would confidently false-pass it
(~100% of the time). At verify time, a `backstop` truth the verifier cannot confirm with
explicit evidence (a passing wired held-out/property-based test, or a directly-observed
behavior) abstains → `human_needed` with reason `insufficient_spec` (reported as
`unverified — held-out test recommended`), never a silent `passed`. This is the verify-time,
truth-axis mirror of the prohibition judgment-tier disposition (ADR-550 D4): exogenous (driven
by the `backstop` tag, never a self-judged "abstain if unsure"), routing-not-diagnosis (the
held-out test carries the omitted rule), and capable-tier dependent (reliable on `sonnet`+;
the budget `haiku` tier degrades toward current behavior). An inferable truth is never
abstained (the over-abstention guard). Reference:
[Honest Verifier](../../gsd-core/references/honest-verifier.md).

## Prohibition probe

### Why a separate probe, and why two stages

The edge probe reaches data-shape edges; it structurally cannot reach prohibitions — the
values/safety/ethics interpretations a feature could silently become that the author would
never want but the spec does not forbid. The prohibition probe is the missing instrument. It
is prose-orchestrated with no compiled recall engine, because recall is inherently
model-driven (ADR-550 D7b). Stage 1 is an adversarial recall question — model-robust,
open-vocabulary elicitation across values/safety/ethics. Stage 2 is a one-pass precision
classifier that drops routine-engineering items and collapses the raw list to the load-bearing
few.

### Why verification is tiered

Each resolved prohibition carries a `verification` tier — `test` (a negative test can enforce
it) or `judgment` (only human/LLM judgment can). Judgment-tier prohibitions route to a
never-silent / never-hard-halt soft gate. Test-tier prohibitions are enforced via the
deterministic `check prohibition-enforcement` gate — green when the wired negative test / lint
rule passes, hard-gate (flagged, non-green) when missing or failing, in both interactive and
autonomous modes (#1259, ADR-550 D5d). Canon-bound concerns (OWASP / GDPR / fairness) are
referred to `/gsd-secure-phase` rather than minting SPEC prohibitions (ADR-550 D6). The
load-bearing wire is the `plan-phase` lift into `must_haves.prohibitions`, so the section is
not merely documentation.

### Why the check descriptor is optional and fail-closed (#1278)

A resolved `test`-tier prohibition may carry an optional `check` descriptor — the flat-scalar
keys `check_kind` (`node-test` | `lint-rule`), `check_target`, and `check_rule` (lint-rule
only) — authored at spec-phase. `projectProhibitions` projects these scalars deterministically
and verify-phase reads them back to locate the check handed to
`check prohibition-enforcement`, so a wired, passing test closes the gap with zero manual
descriptor authoring (previously the verify-phase LLM had to invent `{kind, target, rule}`
each run, #1259). The descriptor is optional and backward-compatible — a descriptor-less
prohibition parses and disposes byte-identically to before — and fail-closed: a partial,
invalid, or absent descriptor falls through to the producer's existing fail-closed locate,
never a silent green. `failFirst` stays a verify-time caller attestation until machine-proven
fail-first (#1279).
