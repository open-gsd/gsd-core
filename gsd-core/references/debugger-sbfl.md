# Spectrum-Based Fault Localization (SBFL) Pre-filter

Loaded by `gsd-debugger` via `@-include`. A deterministic ranked "where to look
first" list derived from existing test pass/fail coverage, computed before LLM
reasoning over an unranked search space.

## Why this exists

`investigation_loop` Phase 1 searches the codebase and reads files to seed
hypotheses via (expensive, non-deterministic) LLM reasoning over an unranked
space. When a runnable test suite with per-test coverage exists, there is a
cheap, deterministic signal being left on the table: which code is
disproportionately executed by **failing** vs **passing** tests. SBFL turns
that coverage spectrum into a suspiciousness ranking. The agent currently has no
fault-localization step at all.

## When to run it (Phase 1.25 — after initial evidence, before hypothesis formation)

Run only when ALL hold:
- A runnable test suite exists for the failing area.
- At least one failing test AND at least one passing test exist (a spectrum
  requires both).
- Per-test coverage is available (which tests executed which code
  element — function, line, or branch).

If any precondition fails, **skip** this step with a logged note (see
Degradation) and proceed with Phase 1's normal evidence gathering unchanged.

## The Ochiai formula

For each code element `s` executed by the test suite:

```
ochiai(s) = failed(s) / sqrt(totalFailed × (failed(s) + passed(s)))
```

where:
- `failed(s)` = number of **failing** tests that executed `s`
- `passed(s)` = number of **passing** tests that executed `s`
- `totalFailed` = total number of failing tests in the suite

The score is in `[0, 1]`. An element executed by every failing test and no
passing test scores `1.0` (maximum suspiciousness). An element touched only by
passing tests scores `0`. Ochiai is empirically stronger than Tarantula across
the SBFL literature; **Tarantula** is the documented fallback formula
(`tarantula(s) = (failed(s)/totalFailed) / ((failed(s)/totalFailed) + (passed(s)/totalPassed))`)
if a comparison or secondary signal is wanted.

## Output — top-N shortlist seeded into the hypothesis space

Rank all executed elements by descending Ochiai score and take the **top-N**
(N is judgment — 5–10 is typical; bounded by what narrows the search without
flooding it). Append each top-N element to the debug file's **Evidence**
section as a first-class hypothesis candidate:

```
- timestamp: <now>
  checked: SBFL Ochiai ranking (Phase 1.25)
  found: top-N suspicious locations —
    1. path/to/file.cts:LINE (score 0.89) — <symbol>
    2. path/to/other.cts:LINE (score 0.77) — <symbol>
    ...
  implication: investigate these before forming broader hypotheses
```

This narrows the search space by orders of magnitude before any LLM tokens are
spent forming hypotheses. Each top-N entry becomes a candidate for Phase 2
hypothesis formation, ranked ahead of un-evidenced guesses.

## Degradation (Gall's Law — optional step, degrades onto the working agent)

This step is **purely additive**. Every miss degrades to today's behavior; a
skipped step is logged, never a silent pass (Kernighan — the debugger stays
auditable).

| Condition | Behavior |
|---|---|
| No test suite for the failing area | **skip** with a logged note in Evidence ("SBFL skipped: no test suite"); Phase 1 proceeds unchanged |
| Test suite but no failing tests | **skip** with a logged note ("SBFL skipped: no failing tests — no spectrum"); Phase 1 proceeds unchanged |
| Test suite but no passing tests | **skip** with a logged note ("SBFL skipped: no spectrum — no passing tests"); Phase 1 proceeds unchanged (Tarantula would divide by `totalPassed=0`; do not run it) |
| Test suite but no per-test coverage | **skip** with a logged note ("SBFL skipped: no per-test coverage available"); Phase 1 proceeds unchanged |
| Coverage exists but is coarse (file-level, not line/function) | run anyway, rank at the available granularity, and note the granularity in Evidence |

## Bug-class gating (pairs with Phase 2B bug-taxonomy routing)

SBFL is the go-to pre-filter for **deterministic failures (Bohrbugs)** — bugs
that reproduce reliably. It is explicitly **not trusted** on
**Heisenbug/Mandelbug** spectra (timing, races, environment-dependent failures):
a flaky suite pollutes the spectrum (a "failing" test that sometimes passes
poisons `failed(s)`), so the ranking becomes noise. When the failure is
non-deterministic (Phase 2B classifies it), **skip SBFL** and route to
record-replay or stability-stress instead. If SBFL has already run before
classification and the class later resolves to Heisenbug/Mandelbug, mark the
prior SBFL Evidence entry as revoked (do not delete it — Kernighan
auditability) and note why in Evidence.

## Scope boundary (Zawinski's Law)

This is a deterministic pre-filter that reuses the project's existing
test/coverage runner — it adds **no new coverage framework** and no new
subsystem. It narrows the LLM's search space; it does not replace hypothesis
formation, fix-and-verify, or the knowledge base. Coverage acquisition is the
agent's adaptive job (use whatever coverage the project produces); the formula
above is the canonical ranking.

**Bound the coverage run** (CLAUDE.md gauntlet — unbounded subprocess): a
coverage run is often 2–3× slower than a plain test run due to instrumentation,
so cap it (60s for npm-tier suites; scale with suite size) and **degrade to
skip with a logged note on timeout** — never let coverage acquisition hang the
debug session.
