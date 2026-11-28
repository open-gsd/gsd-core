# Respond to a new QA smell

`npm run lint:qa-smells` reported an unacknowledged NEW smell, or a STALE baseline entry. A
smell is legal-but-questionable behavior; it never fails a build on its own merits, and what
fails is the absence of a decision about it. Every smell ends in exactly one of two states:
**REAL** (an assigned defect) or **FALSE POSITIVE** (the oracle is wrong; fix the oracle, never
baseline it). A violation or a scenario expectation failure is never acknowledgeable: fix the
engine, or correct the expectation.

## 1. Decide which state it is

Read the finding. If the engine's behavior is wrong, it is REAL. If the oracle in
`tests/qa/oracles.cjs` fires on legitimate behavior, it is a FALSE POSITIVE.

## 2a. False positive: fix the oracle

Change `tests/qa/oracles.cjs` so the smell stops firing, then re-run `npm run lint:qa-smells`.

## 2b. Real: file a defect and acknowledge it

File the defect, then add a fragment under `tests/qa/smell-acks/`. The ratchet's failure output
prints a paste-ready skeleton naming the required `key`, `id`, `scenario` and `issue` fields.
`issue` must be a positive integer naming the tracking issue; a free-text `reason` may accompany
it but never substitutes for `issue`. The full shape and lifecycle are in
`tests/qa/smell-acks/README.md`.

## 3. Regenerate the baseline when pruning a stale entry

```bash
node scripts/qa-smell-ratchet.cjs --update
```

`--update` regenerates `tests/qa/smell-baseline.json` from the current run, folds in acked
fragments and prunes stale entries. It never invents an issue number: a genuinely new smell is
written with `issue: null` and a TODO `reason`, and the next plain run rejects that entry until a
human triages it. The baseline only shrinks; it grows by adding an acknowledgment with a real
issue number, never by widening the generator's tolerance.
