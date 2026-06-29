# Honest Verifier — Abstention on Non-Inferable Checks

Shared reference for the **verify** phase. The verify-time companion to the spec-time
`@~/.claude/gsd-core/references/edge-probe.md` (which *classifies* non-inferable checks) and
`@~/.claude/gsd-core/references/prohibition-probe.md` (whose judgment-tier disposition this mirrors).
This doc is written in generic `spec → predicate → verifier` terms with no tool-specific vocabulary,
so it is portable: copy it into any verification process.

## The problem it solves

A verifier is trustworthy on **inferable** checks — defects determined by the stated spec. On a
**non-inferable** check the correct answer is *not derivable from the spec alone* (e.g. "does `[1,2]`
touching `[2,3]` merge?", "is a 'character' a grapheme or a code unit?"). On these the verifier *does
not know that it does not know*: measured behavior is a **confident PASS on the blind-spot check ~100%
of the time** (mean confidence ~0.93), because a model cannot self-detect a gap it does not perceive.

The edge-probe already detects these at spec time and tags them `verification: backstop` (ADR-550
D7a). The honest verifier consumes that tag so the verifier **abstains** instead of confidently
false-passing — converting a silent false-pass (the worst failure: you don't know to look) into an
explicit, actionable "write a held-out test." Measured: the confident-false-pass rate on the blind
spot drops **100% → 17%** (N17).

## The two properties that define the design

1. **Exogenous, not endogenous.** The trigger is the *external tag* (`backstop`), never the verifier's
   self-judgment. Asking the verifier to "abstain if unsure" barely moves the number (100% → 67%) and
   only on ambiguity it already notices; on a true blind spot it stays confidently wrong. A confidence
   gate cannot reach a blind spot the model does not feel — so there is **no "are you sure?" prompt**;
   routing is on the pre-existing tag only.
2. **Routing, not diagnosis.** The verifier need not name the omitted rule (if it could, it wouldn't
   be a blind spot). In testing, verifiers abstained correctly while citing the *wrong* edge. The
   honest verdict requires only "I was told this is under-specified and I cannot rule it out." The
   omitted rule is carried by a human-authored held-out test, not by the verifier.

## The disposition (the protocol)

For each `must_haves.truths` item:

| Item | Confirmable with explicit evidence? | Disposition |
|---|---|---|
| Inferable (plain string, or `verification: explicit`) | n/a — graded normally | ✓ VERIFIED / ✗ FAILED as usual; **never abstained** (over-abstention guard) |
| Non-inferable (`verification: backstop`) | **yes** (a wired held-out/property-based test that passes, or a directly-observed behavior) | ✓ VERIFIED |
| Non-inferable (`verification: backstop`) | **no** | **abstain** → ⚠️ `insufficient_spec`, flagged, → `human_needed` — **never `passed`** |

- **Explicit evidence** = a wired held-out/property-based test that passes, or a behavior the verifier
  directly observed. Symbol presence + wiring is **not** explicit evidence for a non-inferable truth.
- **Never silent, never a hard halt.** *Interactive:* the abstained item routes to the end-of-phase
  human checkpoint. *Autonomous (AFK):* it produces a prominent `unverified — held-out test
  recommended` flag and the completion line reads "complete with N unverified non-inferable checks";
  the run neither silently passes the blind spot nor hard-halts.
- **Distinguishable reason.** The abstain disposition carries `reason: insufficient_spec` so the
  `human_needed` outcome is never conflated with an ordinary manual-UAT `human_needed`.

This is the verify-time half of ADR-550 Decision 4 (the never-silent-pass disposition), applied to the
edge `backstop` truth tier instead of the prohibition judgment tier — the same machinery, opposite
polarity (must-HAVE under-specified vs must-NOT irreducible).

## Deterministic engine surface

The CI-testable surface is the **deterministic disposition + projection**, never the LLM's judgment
(ADR-550 D5 — a test asserting the model's verdict is vacuous and rejected). In `probe-core`:

- `truthStatement(t)` / `truthVerification(t)` — normalizers; read a truth's statement and tier from
  either the plain-string or object form (a truth-reader MUST normalize, never assume a string).
- `projectTruths(items)` — conservative serializer: a `backstop` truth → flat-scalar object
  `{ statement, verification: backstop }`; every inferable truth → a bare string.
- `dispositionForUnverifiableTruth(truth, { evidence })` → `{ status, flagged, tier, reason }`:
  `backstop` + no evidence → `unverified`/`flagged`/`insufficient_spec`; `backstop` + evidence →
  `green`; non-`backstop` → `green` (over-abstention guard).

## Capable-tier requirement (a documented cost)

Abstention is **model-tier dependent** and this is a standing cost, not an assumption:

- The default `gsd-verifier` tier (`sonnet`, golden/balanced) heeds the exogenous tag reliably
  (2/2 under testing).
- The **budget tier (`haiku`)** is the least flag-responsive (1/2, inconsistent) and **degrades toward
  current behavior** (confident false-pass). Run honest-verifier on a capable tier; treat the budget
  tier as best-effort. Re-validate when the `gsd-verifier` model tier changes or a new budget model is
  adopted (captured as a test so a tier regression is caught, not discovered in production).

## Evidence and scope (stated honestly)

- **Evidence strength.** N17 is n=27 verdicts (3 models × 3 conditions × 3 tasks), 1 rep —
  **direction-finding, not powered.** The blind-spot effect is large and monotone
  (100% → 67% → 17%); the two costs are clean single events (a *false* tag made the strongest model
  over-abstain on a real spec-determined bug; the weakest tier was flag-deaf) and they name exactly
  the failure modes the over-abstention guard and the capable-tier requirement defend against.
- **Tag-precision coupling.** Quality is bounded by the edge-probe's `backstop` recall/precision — a
  false non-inferable flag causes over-abstention. Positive coupling: improving the probe (#1110)
  improves this for free. It adds no independent burden.
- **Explicit non-goals.** Does NOT identify the omitted rule; does NOT recalibrate decisive verdicts;
  does NOT defend against *malicious compliance* (a self-graded review rationalizing away its own
  findings). It raises the floor on *honest* uncertainty about non-inferable checks — that is the
  whole claim.

## Distinct from neighbours

- **vs `PRESENT_BEHAVIOR_UNVERIFIED` (#966 axis):** that is the *inferable-but-unobserved* case — the
  truth **can** be verified from the spec but was shortcut-passed on symbol presence; the fix is to
  demand behavioral evidence. Honest-verifier is the *non-inferable* case — the truth **cannot** be
  verified from the spec at all; the fix is to abstain and route to a held-out test. Orthogonal axes
  (insufficient *evidence* vs insufficient *spec*); both feed the same `human_needed` sink.
- **vs prohibition judgment-tier (#644):** that disposes **must-NOT** constraints; honest-verifier
  disposes **non-inferable positive truths**. Opposite polarity, same never-silent disposition.
