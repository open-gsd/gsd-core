# API-coverage detector fixtures (#2365)

Verbatim reproduction lines from #2365, each used as a `PLAN.md` body and
driven through `check api-coverage.verify-pre <phaseDir>` — the real
blocking gate, not `detectApiIntegration()` called in isolation.

- `nextjs-route-path.txt` — a first-party Next.js route path read as an
  external API signal because `/` is a word boundary.
- `unrelated-verb-noun.txt` — a verb and a noun on the same line, unrelated
  clauses, no compound relation.
- `threat-model-prose.txt` — a threat-model table cell describing a LOCAL
  interface, misread as a third-party service name.
- `non-integration-assertion.txt` — a line that explicitly states no new
  integration was added, misread as evidence of one.

The first three currently `detected: true`; the gate expects `false` for
all four (see `MANIFEST.json`'s `expectedDetected`/`currentBuggyOutput`
fields). `non-integration-assertion.txt` already returns `detected: false`
in isolation, so it's asserted directly. The other three are asserted
against their `currentBuggyOutput` in `tests/representative-corpus.test.cjs`
— a characterization of today's known-broken behavior, not a `todo` (see
`tests/fixtures/representative/README.md` for why `todo` doesn't work with
this repo's test-runner) — until #2365 lands.
