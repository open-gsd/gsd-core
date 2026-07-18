---
type: Added
pr: 2403
---
**`gsd-debugger` now ranks suspect code by Ochiai suspiciousness before forming hypotheses** — when a runnable test suite with per-test coverage exists (≥1 failing and ≥1 passing test), the debugger computes a spectrum-based fault-localization (Ochiai) ranking over the coverage and seeds the top-N suspicious locations into the Evidence section as first-class hypothesis candidates, narrowing the search space deterministically before any LLM reasoning. Tarantula is documented as a fallback formula. The step degrades cleanly (logged, never a silent pass) when there is no test suite, no failing tests, or no per-test coverage, and it is explicitly not trusted on flaky/Heisenbug spectra (pairs with the Phase 2B bug-taxonomy routing). Full rules live in `gsd-core/references/debugger-sbfl.md`. (#1959)
