# ADR 550: spec-phase probe pattern and prohibition contract [Accepted]

- **Status:** Accepted
- **Date:** 2026-06-03

> **Provenance.** Drafted during triage of #644 (prohibition probe), hardened in a `/grill-with-docs` session, and extended with a `probe-core` seam designed in an `/improve-codebase-architecture` grill (Decision 7). Endorsed by the maintainer and by the #644 author (who also authored the edge-probe, #550 / PR #584). This ADR lands **on PR #584** alongside the `probe-core` extraction that implements Decision 7; #644 (the prohibition probe itself) remains blocked until #584 merges and then implements the prohibition adapter. "What exists today" is verified against `next` + the PR-#584 head as of 2026-06-03.
>
> **Lineage.** The judgment-tier contract (Decision 4) was reached independently from two directions: from the domain model (truths are unenforced positive-observables, so a values prohibition cannot be a silent pass) and from the author's "verifier-abstention" (N17) calibration experiment (on irreducible values rules the verifier is confidently wrong — ~0.93 confidence, ECE 0.81 — so confidence-gating cannot help; the only honest move is abstain-and-flag). That parked experiment folds into this ADR as the verify-time half of judgment-tier rather than needing a separate feature.

## Context

`spec-phase` produces `SPEC.md` from an interview. Two features add *probes* — soft-gate steps that surface spec gaps before code is written: **#550 / PR #584 (edge-probe)** for data-shape edges, and **#644 (prohibition probe)** for values/safety "must-NOT" constraints. Both use identical three-layer packaging and a recall→precision protocol, and both want confirmed findings to reach `SPEC.md` and the plan contract.

Grounding the design against the codebase surfaced the decisive facts:

- **`truths` are positive, observable assertions.** `gsd-planner` derives them as *"observable truths (3-7, user perspective)"*; `verify-phase` checks each by *"determine if the codebase enables it"* — a presence/wiring check. A prohibition is the inverse and cannot be confirmed that way.
- **`truths` are not mechanically verified.** `verify.cjs` iterates `artifacts` and `key_links` but has no `truths` handler. A prohibition parked in `truths` would inherit that non-enforcement — a negative wearing a positive's clothing.
- **`must_haves` has no schema/type** — a convention parsed by `parseMustHavesBlock` (blocks `truths`/`artifacts`/`key_links`), read in ≥6 places.
- **The SPEC→plan lift is LLM reasoning** in `gsd-planner`'s `derive_must_haves`, not mechanical extraction.
- **Prohibitions already exist in GSD only as narrative prose** (`<scope_reduction_prohibition>`, `"MUST NOT loop"`), never as structured, verifiable data.
- **The edge-probe's load-bearing logic is a deep module on the live path.** `src/edge-probe.cts` (~297 lines) is compiled to `bin/lib/edge-probe.cjs` and invoked by `spec-phase` Step 5.5 at runtime. ~120 of its lines are a *generic resolution model* (status lifecycle, validation, merge/rollup, CLI); only the `Shape`/`SHAPE_CUES`/`TAXONOMY`/`classifyShape`/`proposeEdges` cluster is edge-specific. The prohibition probe is the **second adapter** of that model — making the seam real (one adapter is hypothetical; two is real).
- **No prior ADR** governs probes, soft gates, or `must_haves` evolution.

The values/safety class #644 targets (*"must not become a guilt mechanic"*) is frequently **not reducible to a deterministic test** — which is why it needs an explicit verification contract rather than truth-style limbo.

## Decision

1. **Probe packaging (three layers).** Every spec-phase probe ships as: (a) a portable, dependency-free reference core under `references/<probe>.md` (taxonomy + protocol + output schema); (b) a `spec-phase.md` step run as a **soft gate** (write-anyway-with-flags), with explicit `--auto` and text-mode (non-Claude, no `AskUserQuestion`) handling, mirroring the ambiguity gate; (c) tests + docs.

2. **Two-stage protocol.** **Recall** (adversarial over-generation) → **precision** (classifier dropping routine engineering items), surfacing a short confirmable list. Dismissals require a non-empty reason.

3. **Prohibition home & representation.** Confirmed prohibitions live primarily as **`SPEC.md` acceptance criteria** (negative criteria). They MAY be projected into an optional **`must_haves.prohibitions:` sibling block** (alongside `truths`/`artifacts`/`key_links`) when they must survive into the plan contract. **`truths` is left untouched** — no `polarity` field is added. Each prohibition item carries `statement`, the orthogonal `status` + `verification` of Decision 7, and (when dismissed) a non-empty `reason`.

4. **Tiered verification.** Each prohibition declares `verification: test | judgment`.
   - **`test`-tier** (reducible to a deterministic assertion) → a **negative test** following `regression-must-fail-first` + negative-proof discipline. **Hard gate in both interactive and autonomous modes.**
   - **`judgment`-tier** (irreducible values/safety rule) → **mode-dependent soft-gate-with-flags**: *interactive* verify requires explicit human resolution of each item; *autonomous* verify records an LLM-judge verdict **marked non-authoritative** and emits a prominent *"unverified prohibition — human review recommended"* flag in SUMMARY/verdict. **Never a silent pass; never a hard halt of AFK runs.** Autonomous completion reads *"complete with N flagged prohibitions."*
   - *Optional future input:* cross-tier (or cross-model) disagreement MAY feed the judgment-tier flag as a cheap blind-spot signal. This is a breadcrumb, **not a dependency** — the flag stands without it.

5. **The CI-testable surface is the contract, not the classifier.** The recall/precision/tier-assignment stages are LLM behavior and are **not** claimed as deterministic CI coverage (validated by offline batteries; in CI only by source-grep-under-`// allow-test-rule:`-exemption over reference/workflow prose, which *is* the product). CI deterministically tests the **contract**: (a) parse + validate an item (`statement` present; `status ∈ {resolved, dismissed, unresolved}`; `verification` in the probe's allowed set; dismissed items carry a non-empty `reason`); (b) round-trip / projection between `SPEC.md` and `must_haves.prohibitions:`; (c) a `DEFECT.GENERATIVE-FIX` **parity assertion** across template ↔ parser ↔ planner; (d) `test`-tier items are provably wired into verify-phase and cannot be silently skipped. A test that asserts the LLM's *judgment* is vacuous and is rejected per `RULESET.TESTS.delete-bad-tests`.

6. **Ownership seam with security tooling.** The probe owns **bespoke product/values** prohibitions only. When precision classifies an item as **canon security/compliance** (OWASP/GDPR/fairness/prototype-pollution/path-traversal), it does **not** mint a SPEC prohibition; it emits a one-line breadcrumb (*"possible canon-security concern X — owned by `/gsd:secure-phase` / eslint"*) and stops. Canon checks are **referred, not duplicated** — keeping the surfaced list short (#644's ~2–3-item goal).

7. **`probe-core` is the seam; probes are adapters.** The shared resolution model is extracted into `src/probe-core.cts`; `edge-probe.cts` refactors onto it as the first adapter and the prohibition probe is born on it as the second. Sub-decisions, each chosen against both probes:
   - **7a — Orthogonal model.** The item carries two orthogonal dimensions: `status: resolved | dismissed | unresolved` (resolution lifecycle, shared) and `verification: <probe-defined> | null` (edge: `explicit | backstop`; prohibition: `test | judgment`). This replaces edge-probe's shipped `status: covered | dismissed | backstop | unresolved`, which smuggled a verification fact (`backstop`) into a lifecycle enum. Migration is mechanical (`covered → {resolved, explicit}`, `backstop → {resolved, backstop}`, others straight across); `coverage.resolved` is preserved (`status === resolved`); the 6 edge fixtures are re-generated on #584. Done now (one adapter) rather than against a fixture-locked enum later.
   - **7b — Core ingests already-proposed items.** The seam is `analyzeCoverage(items, resolutions?, validators)`, **not** `(requirements, proposeFn, …)`. The probes have different deterministic surfaces — edge = deterministic propose (`proposeEdges`) + LLM resolve; prohibition = **LLM propose** (adversarial recall) + deterministic validate/merge/rollup — so core MUST NOT assume propose is deterministic. `proposeEdges` stays in the edge adapter; candidate-parsing stays in the prohibition adapter.
   - **7c — Hybrid typing.** Generic type params on the exported interfaces for adapter-authoring DX, but the load-bearing enforcement is **injected runtime validators** (`{ categories, verification, requiredFieldsByVerification }`), because the probe runs as a CLI over JSON where TS types are erased. The contract test (Decision 5) pins the validators, not the types.
   - **7d — Rollup carries a verification tally.** `CoverageReport.coverage` gains `byVerification: { <tier>: count }`, computed generically in core over items that have a verification set. Verify-phase reads `byVerification.judgment` as Decision 4's denominator without re-scanning. (Unresolved items carry no tier and are counted by `status`.)
   - **7e — One bin per probe.** Each probe ships its own compiled bin (`edge-probe.cjs`, `prohibition-probe.cjs`) calling a shared `runProbeCli(...)`. A single dispatcher CLI is **deferred** as an independent follow-on: unlike the enum, it is pure invocation plumbing with no migration debt, so it does not justify enlarging the #584 blast radius.

   Indicative `probe-core` surface:
   ```ts
   export type Status = 'resolved' | 'dismissed' | 'unresolved';
   export interface Item<TCat extends string = string, TVer extends string = string> {
     requirement_id: string; category: TCat; status: Status;
     verification: TVer | null; resolution: string | null; reason: string | null;
   }
   export interface CoverageReport {
     items: Item[];
     coverage: { applicable: number; resolved: number; unresolved: number; byVerification: Record<string, number> };
   }
   export interface ProbeValidators {
     categories: ReadonlySet<string>; verification: ReadonlySet<string>;
     requiredFieldsByVerification?: Record<string, ReadonlyArray<keyof Item>>;
   }
   export function analyzeCoverage(items: Item[], resolutions: Resolution[] | undefined, v: ProbeValidators): CoverageReport;
   export function validateResolution(r: Resolution, items: Item[], v: ProbeValidators): void;
   export function validateItems(items: Item[], v: ProbeValidators): void;
   export function runProbeCli(opts: { ingest: (argv: string[]) => { items: Item[]; resolutions?: Resolution[] }; validators: ProbeValidators }): never;
   ```

## Consequences

- **Positive:** `truths` keeps its positive-observable semantics; prohibitions get a first-class home with a real verification lifecycle; CI is honest (tests the contract, never fakes the model's judgment as green); no fake-green and no gutted autonomy; the secure-phase boundary is explicit and de-duplicated; the resolution model lives in one place, so the third probe is nearly free and `verification`/`status` cannot drift across the ≥6 `must_haves` read sites.
- **Costs / required work (on #584):** extract `probe-core.cts` and refactor `edge-probe.cts` onto it; re-cut the status enum into `status × verification` and re-generate the 6 edge fixtures. **On the #644 PR:** add the prohibition reference + the `must_haves.prohibitions:` block and its `parseMustHavesBlock` extension; the `DEFECT.GENERATIVE-FIX` parity assertion across template ↔ parser ↔ planner (**owned by the #644 author**); extend the SUMMARY/verdict schema with the `unverified-prohibition` flag; teach verify-phase the test-tier wiring and judgment-tier mode-dependent handling. A deterministic `projectProhibitions()` in `probe-core` is recommended so the parity assertion tests a function's round-trip rather than a prompt; every existing `must_haves` read site must tolerate the new block (absence = no prohibitions).
- **Docs debt:** `spec-phase` is undocumented in `FEATURES.md`/`COMMANDS.md` despite shipping in v1.38; the docs-required gate bites both probes. PR #584 establishes the spec-phase docs section.
- **Glossary:** `probe family`, `probe-core`, `verification tier`, and `bespoke vs canon prohibition` are added to `CONTEXT.md` when #584 merges (not while the contract is pre-merge); this ADR is their interim home.
- **Sequencing:** PR #584 lands ADR 550 + `probe-core` + the `edge-probe.cts` refactor + enum re-cut + fixture re-gen + the spec-phase docs section. #644 then adds the prohibition adapter (reference + `prohibitions:` block/parser/parity + tiered verification). #644 stays blocked until #584 merges.
