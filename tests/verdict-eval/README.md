# verdict-eval — held-out false-PASS behavioral eval (#1637)

The committed, CI-runnable false-PASS eval that issue #1637 asks for. It makes the
`100% → 67% → 17%` measurement behind the B1 brief **reproducible in-repo** (it previously lived
only in a personal fork), and it answers the question #1637 was opened to settle: *does endogenous
critic self-disconfirmation earn its place as a verification control?*

**It ships NO agent-prompt changes.** It is the eval instrument + the evidence, nothing more. It
follows the existing `edge-probe-fixtures` record-and-score pattern (committed fixtures + a
deterministic, key-free replay scorer — no model is called in CI).

This directory is a convergence of two complementary layers, contributed independently and
reconciled here:

## Layer A — behavioral surface (powered, the base)

A **43-item artifact corpus** (`{claim, code}` pairs) judged **blind** by a critic, recorded on
**two models (Sonnet, Haiku)** across **four modes**, scored **per class**, golden-locked.

```
corpus-items.json        43 vetted items (label provenance; never shown to the critic)
corpus.cjs               loads + shapes the corpus
harness.cjs              pure scorer: judge(), scoreCritic() (per-class), evalGate() (typed GATE_REASON)
recorded-transcripts.json   real blind recordings: {model: {mode: {id: transcript}}}
transcripts.cjs          wires recorded transcripts + a synthetic flag-everything adversarial mode
expected-results.json    GOLDEN per-(model,mode,class) metrics, regenerated from the transcripts
../verdict-eval.test.cjs    node:test suite (judge, scoring, gate, boundary, property, golden)
```

Classes (adversarially **LLM-vetted** for blind-safety + correct label): `inferable` (12),
`domain-knowledge` (10), `spec-silent` (14), `clean` (7). Modes: `baseline`, `disconfirmation`
("re-derive criteria, then disconfirm your verdict"), `abstention` ("don't PASS unless confident;
FLAG what you can't confirm"), `exogenous` (baseline + the omitted boundary supplied as a hint = the
#1154 arm). `judge()` extracts the verdict by token-regex from each recorded transcript — key-free.

### Powered results (per-class recall; golden-locked)

| model | mode | inferable | domain-knowledge | spec-silent | clean true-PASS prec |
|---|---|---|---|---|---|
| Sonnet | baseline | 100% | 80% | 36% | 100% |
| Sonnet | disconfirmation | 100% | 80% | 36% | 100% |
| Sonnet | abstention | 100% | 80% | **57%** | 100% |
| Sonnet | exogenous (#1154) | 100% | 100% | 79% | 100% |
| Haiku | baseline | 100% | 60% | 43% | 86% |
| Haiku | disconfirmation | 100% | 70% | 50% | 86% |
| Haiku | abstention | 100% | 60% | **64%** | 100% |
| Haiku | exogenous (#1154) | 100% | 100% | 71% | 100% |

**What the data says:**

- **Inferable is saturated (100% everywhere)** — the verifier already catches visible claim↔code
  contradictions; B1 adds nothing there.
- **Disconfirmation is a no-go** — net-zero on Sonnet (and it *regressed* a correct flag:
  `pagination-index-base` FLAG→PASS), only +7pp on Haiku.
- **Abstention is a cheap, real win** — **+21pp on the spec-silent slice on both models, at zero
  over-block cost** (Haiku's clean precision even rose 86→100%). It does ~nothing for
  domain-knowledge (abstention is not a *knowledge* mechanism). Abstention does not *catch* the
  defect — it **routes** it (PASS→FLAG), i.e. it is the verify-time trigger for #1154.
- **Exogenous (#1154) is the closer** — domain-knowledge →100%, spec-silent →71–79%.

**Recommendation this supports:** disconfirmation should not ship as a control; **abstention is
worth keeping as the #1154 trigger**; #1154 is the load-bearing arm. #1637 stays distinct from and
subordinate to #1154. No agent-prompt change is made here — that decision is downstream of this
evidence.

## Layer B — mechanically-proven core (the determinism gate)

Dave's N17 `verifier-abstention` experiment, ported in: **executable fixtures** with a gate that
*proves* non-inferability mechanically rather than by label.

```
fixtures/<task>/
  spec.md         contract that plainly states the rules but OMITS one boundary
  reference.mjs   correct implementation
  defective.mjs   plausible-wrong impl; the defect sits on the omitted boundary
  visible.mjs     suite the executor ran (both impls PASS)
  heldout.mjs     suite encoding the omitted rule (only the defective impl FAILS)
  meta.json       slice label + provenance + `disputed` flag
seed-verdicts.tsv recorded model verdicts (N17, n=27) — the replay seed
../verdict-eval.integration.test.cjs   determinism gate + per-slice replay scorer
```

**The determinism gate:** a fixture is a valid non-inferable probe **only if** the reference passes
`visible`+`heldout`, the defective passes `visible`, and the defective **FAILS** `heldout`. The SUT
is injected via `GSD_SUT`, so one suite runs against either impl. This operationalizes "what counts
as non-inferable" as a mechanical check, not a claim. It includes the **confound-fixed banker's**
fixture (`01-round-half-even`): an EPS-guarded half-up that deviates from the reference *only at
exact ties*, so the sole distinguishing input is the tie — removing the inferable FP confound the
original `Math.round(v*f)/f` carried.

## Shared taxonomy + why the two layers converge

"Non-inferable" is **not one thing** — both layers use the same split:

| slice | meaning | what helps |
|---|---|---|
| `domain-knowledge` | a right answer exists; the model has the knowledge but doesn't surface it unprompted | disconfirmation (weak) / exogenous (#1154) |
| `spec-silent` | a free definitional choice; no right answer absent the spec | **abstention routes it**; only #1154 *closes* it |
| `inferable` (control) | the rule is stated; spec-determined | the verifier already catches it ~100% |

Layer B's N17 seed used **abstention** as its endogenous arm; an earlier run on the thread used
**disconfirmation**. They move *opposite* slices — which is exactly the powered Layer-A result above,
now measured at scale on one corpus rather than argued. `meta.json.disputed` flags the fixtures where
the two seeds disagreed; the powered run adjudicates them.

## The gate (non-gameable) vs the report

- **Reported, never gated:** the non-inferable slices (`domain-knowledge`, `spec-silent`). Their
  movement is direction-finding; the silent slice is #1154's territory.
- **Gated floors:** inferable recall (a pass-everything critic fails) **and** clean true-PASS
  precision / over-abstention on the inferable control (a flag-everything / always-abstain critic
  fails). A blended aggregate verdict is never produced — per-slice keeps the blind spot visible.

## Honest limits

- Layer A: 43 items, two models, one run/seed — robust enough to reverse the first-run signal, not a
  large-scale study. Classes are **LLM-adversarially-vetted**, not mechanically proven.
- Layer B: n=27, one rep, three models, three recorded tasks — direction-finding. Its exogenous arm
  modeled a *perfect* tagger, so `17%` is an upper bound. Verdicts are **recorded**, not live.
- The two layers are complementary: Layer A gives breadth + a powered multi-model signal; Layer B
  gives a mechanically-proven non-inferable anchor. Neither alone is a ship decision.

## Run

```bash
node --test tests/verdict-eval.test.cjs               # Layer A: behavioral corpus + golden
node --test tests/verdict-eval.integration.test.cjs   # Layer B: determinism gate + replay
```

Both are key-free and deterministic (replay committed transcripts/verdicts). To re-record Layer A
(new model or larger corpus), re-run the offline recording, overwrite `recorded-transcripts.json`,
and regenerate `expected-results.json`.
