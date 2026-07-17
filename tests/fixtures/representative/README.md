# Representative Gate Fixtures (#2371)

Every fixture in this tree is **verbatim** (or, where noted, a minimal
faithful subset) of an artifact that a real user actually produced and
reported against a real GSD gate. None of it was written by a gate's own
author to exercise that gate.

## Why this directory exists, and why `tests/fixtures/adversarial/` isn't enough

`tests/fixtures/adversarial/` covers hostile input — unicode, CRLF, nested
fences, heredoc breakout. Nobody attacked the gates these fixtures target.
A developer wrote an ordinary, well-formed artifact — a plan, a coverage
matrix, a CONTEXT.md — that a gate misjudged anyway. That input is neither
synthetic-happy nor adversarial; it's simply *real*, and until #2371 no gate
had coverage for it.

The pattern this corpus exists to break: a gate's test fixtures were
authored by the same person (or model) who wrote the gate, from the same
mental model, so they can only confirm what the author already believed —
never surface what the author didn't anticipate. See #2371 for the full
diagnosis (four incidents across three gates in ten days, including a
fast-check property test whose generator was seeded from the parser's own
writer function and therefore could not fail).

## Rule

**A gate's fixtures may not be derived from the gate's own writer, grammar,
or docstring examples. A negative fixture must come from a source that
does not know the gate exists.** Recorded in `CONTRIBUTING.md` under
"Fixture provenance."

## Layout

Each subdirectory is one gate:

- `api-coverage-detector/` — `detectApiIntegration` (#2365)
- `api-coverage-matrix/` — `parseCoverageMatrix` (#2366)
- `audit-uat/` — `parseUatItems` / `parseVerificationItems` (#2286, fixed by #2317)
- `decision-coverage-guard/` — `extractDecisions`'s could-not-parse guard (#1365 gap, #2347)

Each carries its own `README.md` (what each fixture is and where it came
from) and `MANIFEST.json` (machine-readable: file → source issue → gate →
expected verdict). `tests/representative-corpus.test.cjs` loads every
manifest and drives each fixture through the gate's real CLI entrypoint —
never the parser function directly — so the assertion is at gate-verdict
altitude (the boolean/JSON a user actually sees), not parse-tree altitude.

## Why some assertions are `{ todo: '#NNNN' }`

Two of the four gates here are still open bugs (#2365, #2347) at the time
this corpus was added. Their fixtures encode the *correct* expected verdict,
which today's code does not deliver — the assertion genuinely fails. Per
Node's documented `test()` `todo` option, a todo test still executes and
still reports its failure, but does not affect the process exit code
(https://nodejs.org/api/test.html#test-options) — so the gap is visible in
every test run without blocking `gsd-test` or requiring a code fix here.
The fixes belong to #2365 / #2366 / #2347, not to this corpus. When one of
those lands, remove its fixture's `todo` — the assertion should then pass
for real, and a still-red result after the todo is removed means the fix
didn't fully cover this fixture.

The `audit-uat/` corpus has no `todo`: #2286 was fixed by #2317 before this
corpus was written, so its assertions are ordinary, currently-passing
tests — the proof that a representative fixture, driven through the real
gate, is not automatically doomed to fail. It demonstrates the methodology
working, not just the gaps it finds.
