# Adversarial planning-state fixtures (#5320)

Hostile / messy STATE.md inputs for the plan-line reader and writer in
`src/state-transition.cts` (`readPlanLines`, `plannedPhaseCore`).

`tests/state-transition.test.cjs` ("#5320 adversarial planning-state fixtures")
feeds each file to `transitionCore` as a `plannedPhase` transition with a count of 5 and pins the specific verdict:

- `plan-line-inside-fenced-code.md` — a fenced block holds `Plan: 9 of 9`. The reader
  ignores it, so the real `Plan: 1 of 3` is rewritten to `1 of 5` and the fenced line stays.
- `duplicate-plan-lines.md` — two `Plan:` lines. The first one is the line `advance-plan`
  reads, so it is the one written; the second stays as written.
- `null-byte-plan-line.md` — a NUL after the total. The total is rewritten and the trailing text is kept.
- `unclosed-frontmatter-plan-line.md` — a frontmatter fence that never closes. The `Plan:` line is still rewritten.

CRLF and mixed LF/CRLF documents are built inside the test, because `.gitattributes` (`eol=lf`) normalises a stored fixture.
