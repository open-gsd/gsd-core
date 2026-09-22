---
type: Fixed
pr: 4903
---
**Windows conformance-tier CI no longer blows its own chunk timeout on unmeasured test files.** `scripts/run-tests.cjs` now weighs a test file absent from `tests/test-timings.json` at the documented ~2.2x Windows-cost floor instead of the plain (Linux-measured) table mean, on win32 only — a cluster of unmeasured conformance-tier files could otherwise pack into one chunk and exceed the 600s per-chunk backstop even though the chunk looked in-budget. (#4434)
