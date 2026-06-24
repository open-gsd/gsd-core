# verdict-eval — held-out false-PASS behavioral corpus (#1637)

The committed, CI-runnable false-PASS eval that issue #1637 asks for. It makes the
`100% → 67% → 17%` measurement behind the B1 brief **reproducible in-repo** instead of in a
personal fork. Ported from the `non-inferable-corpus` / N17 `verifier-abstention` experiments.

**This is the eval instrument + a direction-finding seed — NOT a B1 ship decision.** It deliberately
ships **no** agent-prompt changes, and follows the existing `edge-probe-fixtures` record-and-score
pattern (committed golden fixtures + a deterministic, key-free replay scorer).

> **Status (#1637 thread):** a scaled powered run (43 items, two models, 258 judgments) has since
> landed and **supersedes this seed's numbers** — its finding is that endogenous self-check (B1) is
> weak/model-dependent and the **exogenous arm (#1154) is the load-bearing lever**. This corpus is
> the *reproducible, in-repo* determinism gate + seed offered to **converge with** that powered
> corpus, which should be the base. The two are complementary (see "Two seed datasets" below).

## What's here

```
fixtures/<task>/
  spec.md         spec that plainly states the contract but OMITS one boundary rule
  reference.mjs   correct implementation
  defective.mjs   plausible-wrong implementation, defect sits on the omitted rule
  visible.mjs     suite the executor ran (both impls PASS it)
  heldout.mjs     suite encoding the omitted rule (only the defective impl FAILS it)
  meta.json       slice label + provenance
seed-verdicts.tsv recorded model verdicts (N17, n=27) — the replay seed
```

The SUT is injected via the `GSD_SUT` env var, so one suite runs against either impl.

## The non-inferable property (and the determinism gate)

A defect is **non-inferable** when its distinguishing input cannot be reconstructed from
*(the spec shown to the critic) + (general engineering knowledge)*. The harness proves each
fixture has the property mechanically: **reference passes visible+held-out; defective passes
visible but FAILS held-out.** A fixture that does not satisfy this is not a valid probe.

## The two-slice taxonomy (per the #1637 thread)

"Non-inferable" is not one thing:

| slice | meaning | example | what helps |
|---|---|---|---|
| `domain-knowledge` | a right answer exists; the model *has* the knowledge but doesn't surface it unprompted | grapheme vs code unit (task 03) | a **disconfirmation** prompt can recover it |
| `truly-spec-silent` | a free definitional choice with no right answer absent the spec | touching intervals (task 02) | only an **external hint** (#1154 exogenous arm) closes it |
| `inferable` (control) | the rule IS stated; spec-determined | output not sorted (task 02b) | the verifier already catches it ~100% |

## Two seed datasets disagree — by design

The seed here is N17, whose **endogenous arm was *abstention*** (`insufficient_spec` — passively
decline). A separate run reported on the thread used **active *disconfirmation*** ("re-derive
criteria, then disconfirm your verdict"). They land on **opposite** non-inferable tasks:

- abstention recovers the **truly-spec-silent** task (the model notices genuine ambiguity → declines)
  and misses the **domain-knowledge** task (confidently wrong, nothing to notice);
- disconfirmation does the inverse (surfaces latent knowledge → catches the domain-knowledge task;
  cannot resolve a free spec choice → misses the truly-spec-silent one).

`meta.json.disputed` flags the tasks where the two seeds disagree. The point of committing the
corpus is that this can only be **adjudicated by a shared powered run**, not by argument.

## The gate (non-gameable) vs the report

- **Reported, never gated:** the non-inferable slices (`domain-knowledge`, `truly-spec-silent`).
  Their movement is direction-finding and, for the silent slice, #1154's territory.
- **Gated (the floor):** on the `inferable` control, baseline+endogenous must **catch** the
  spec-determined defect (recall floor) and must **not abstain** on it (over-abstention floor).
  A *pass-everything* critic fails the recall floor; a *flag-everything / always-abstain* critic
  fails the over-abstention floor.

## Honest limits

- **n = 27, one rep, three models, three recorded tasks.** Direction-finding, not powered.
- The seed's **exogenous arm was a prompt instruction modeling a perfect-recall tagger**, not a
  real detector — so its `17%` is an upper bound on a *perfect* tag.
- `seed-verdicts.tsv` is **recorded**, not live. It is the replay seed for a real-model adapter,
  which the powered run supplies.
- The precision guard here is **over-abstention on the inferable control**, not a true clean-code
  false-block measure. The powered run should add no-defect (clean) fixtures to gate false-blocks
  directly.

## Run

```bash
node --test tests/verdict-eval.integration.test.cjs
```
