# Design note: "Verifier reach = spec reach" (the probe family's organizing principle)

> **What this is.** A design-rationale doc — *not* an ADR. It records the organizing principle
> behind the spec-completeness probe family and orients a reader to the subsystem. The
> point-in-time decisions it references are owned by ADR-550, ADR-857, and ADR-1606.
>
> **Attribution.** The calibration evidence below is *the author's own research* (the
> verifier-reach experiment program). It is cited here as the **motivation** for a GSD design
> principle — it is not claimed as a novel GSD contribution, and the principle's *framing* is
> the author's. External prior art exists for individual pillars (clarification-questioning,
> omission-decay, conformal abstention); specific citations are deliberately omitted pending
> primary-source verification before being written down.

## The principle

> **A goal-backward verifier can only check assertions that exist. An assertion only exists
> for a requirement that was written down. Therefore the verifier's reach is bounded by the
> spec's reach — and you raise reliability by widening the spec, not by sharpening the
> verifier.**

This is the single idea that ties the spec-completeness probe family together. It explains
*why* the probes live at the front of the pipeline (spec-phase), why enforcement is
fail-closed, and why the verifier is graded **exogenously** against explicit predicates
rather than trusted to grade itself. The principle is already stated in ADR-857's
*"Verification substrate vs. plug-in tier (the predicate boundary)"* section ("the load-bearing
finding: *verifier reach = spec reach*"), and is surfaced as the `PROBE.principle` predicate in
`CONTEXT.md` by sibling PR #1608 (epic #1605); this note expands the rationale and the evidence
behind it.

## Why sharpening the verifier alone does not work

The author's calibration experiments found the verifier is **most confidently wrong on
exactly the cases that matter**:

- **Non-inferable corpus.** On non-inferable edge defects, a held-out check caught 100%
  while the verifier caught **0/12** — and the verifier was overconfident doing it
  (ECE ≈ 0.81). Confidence-gating cannot rescue this: the model is ~0.93-confident and wrong,
  so there is no threshold that separates its hits from its misses. The only honest move on an
  irreducible case is **abstain-and-flag**, not a higher bar.
- **Self-grading drifts.** A verifier asked to grade its own work against a restated goal
  rationalizes a pass (the prose-drift / self-graded-review failure modes reproduced
  independently on #664). Grading must be **against the spec's explicit predicates**, never a
  self-restatement.

The conclusion is structural: reliability is **not** a verifier-tuning problem. The verifier
is fine *when the predicate exists*; it fails when the predicate was never written. So the
leverage is upstream — make the missing predicate exist.

## How GSD operationalizes the principle

Three moves, each a member of the probe family or its enforcement seam:

1. **Widen reach on the shape axis — the Edge-Probe.** A deterministic shape taxonomy
   surfaces the boundary/adjacency/encoding/ordering edges an author omits. The author's
   residual experiment (n=121) found that **once a surfaced edge is resolved into the spec,
   the verifier then catches it 94–100%** — i.e. resolving the omission closes the gap the
   verifier could not. The remaining miss is a *recall* gap in the probe, not a verifier gap.

2. **Widen reach on the must-NOT axis — the Prohibition Probe.** A shape taxonomy is the
   wrong instrument for "must not shame the user" / "must not proxy on protected attributes"
   (the edge-probe caught 0/8 of these). Adversarial elicitation ("what could this silently
   become that the author would not want?") is **model-robust recall** (N18: 17/17 holistic
   surfacing including small models), and a one-pass precision classifier collapses the raw
   list to the ~2–3 genuine bespoke prohibitions.

3. **Close the residual honestly — tiered enforcement + exogenous abstention.** A surfaced
   prohibition is only as good as what verify-phase does with it:
   - **test-tier** → the deterministic `check prohibition-enforcement` producer machine-proves
     the wired check is fail-first and runs it; green only on a proven, non-vacuous pass, else
     hard-gate. The verifier *consumes* a contract-shaped predicate; it does not judge.
   - **judgment-tier** (irreducible values) → **exogenous abstention**: record a
     non-authoritative LLM-judge verdict and emit an "unverified — human review recommended"
     flag. The author's N17 experiment showed this drops the false-pass rate from **100% →
     17%**, where endogenous (self-confidence) gating barely moved it. Never a silent pass;
     never a hard halt of an AFK run.

## Design implications (what this principle forbids)

- **Do not** try to buy reliability by making the verifier stricter or more confident — it is
  overconfident precisely on the non-inferable cases. Spend the effort on spec reach.
- **Do not** let the verifier grade a restated goal; grade against explicit predicates
  (test-tier checks, judgment-tier flags).
- **Do not** put the verifier↔predicate contract behind an off-by-default capability. Because
  predicates *are* the verifier's reach, gating them would make core reliability a function of
  an optional plug-in — settled core/non-toggleable by ADR-857 (the *"Verification substrate
  vs. plug-in tier"* section, decision #6).
- **Do** keep CI honest: test the **contract** the verifier consumes (parse/validate,
  projection round-trip, fail-closed guards), never assert the LLM's judgment as green
  (ADR-550 D5). A test that grades the model's judgment is vacuous.

## The three failure modes this defends against

| Failure mode | Without the principle | With it |
|--------------|----------------------|---------|
| Omitted **edge** (boundary/encoding/ordering) | ships; verifier never had an assertion | edge-probe surfaces → verifier catches 94–100% |
| Unwritten **must-NOT** (values/safety) | passes a literal spec while violating intent | prohibition-probe surfaces → test-tier enforced / judgment-tier flagged |
| Verifier **overconfidence / self-grading** | confident green on a real miss (ECE 0.81) | exogenous grading + abstention (false-pass 100%→17%) |

## Cross-references

- **ADR-550** — spec-phase probe contract (states the principle in its ADR-857 cross-reference
  section); its "Alternatives considered" holds the recall-side rejections (why not a general
  classifier / deterministic recall engine).
- **ADR-1606** *(proposed)* — prohibition-enforcement verify-time seam (the
  test-tier mechanism); its "Alternatives considered" holds the enforcement-side rejections.
- **ADR-857** — *"Verification substrate vs. plug-in tier (the predicate boundary)"* section
  (decision #6): the verifier↔predicate contract is core, non-toggleable.
- Refs: `gsd-core/references/{edge-probe,prohibition-probe}.md`; CONTEXT.md predicate
  `PROBE.principle=verifier-reach-equals-spec-reach`.
- Author's research (internal): non-inferable corpus; edge-probe residual (n=121); N17
  verifier-abstention; N18 prohibition-elicitation.
