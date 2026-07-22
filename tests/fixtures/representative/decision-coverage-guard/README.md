# Decision-coverage guard fixture (#2347)

`d5-prefix-context.md` is the verbatim reproduction shape from #2347 — the
`- **D5-01:** some decision` bullet given in the issue's own "Steps to
reproduce" — used as a CONTEXT.md `<decisions>` block and driven through
`query check.decision-coverage-plan <phaseDir> <contextPath>` (the real
CLI gate; see `tests/decisions.test.cjs` for the established pattern this
follows), not `extractDecisions()` called in isolation.

The #1365 fail-loud guard's "is this decision-shaped?" evidence test
(`/\bD-[A-Za-z0-9]/`) reuses the same `D-` grammar as the parser it guards.
For any ID prefix the parser cannot read — `D5-01` here — the guard sees
no evidence either, so the two failure modes the guard exists to
distinguish (`none-present` vs `could-not-parse`) collapse into
`none-present`, and a populated, genuinely decision-shaped CONTEXT.md
passes silently.

Expected once fixed: `reason: 'could-not-parse'`, `passed: false` (see
`MANIFEST.json`'s `expectedReason`/`expectedPassed`). Today's gate instead
reports `passed: true, skipped: true, reason: 'no trackable decisions'` —
pinned in `MANIFEST.json`'s `currentBuggyOutput` and asserted directly in
`tests/representative-corpus.test.cjs` (a characterization of today's
known-broken behavior, not a `todo` — see
`tests/fixtures/representative/README.md` for why) until #2347 lands.
