---
type: Fixed
pr: 0
---
**The test runner no longer breaks under a relative TMPDIR** — scripts/run-tests.cjs exported its run temp root unresolved, so with a relative TMPDIR thousands of unit tests failed and fixtures were written into the checkout; the root and fixture directories are now absolute. (#5688)
