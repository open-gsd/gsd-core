---
type: Fixed
pr: 370
---
**Affected-tests PR runner no longer selects or runs `install`/`slow` suites (#370)** — `pickAffectedTests` now filters out any file whose suite is `install` or `slow` at the single chokepoint, covering direct-change, reverse-index, and stem-match selections. The `DEFAULT_SMOKE_TESTS` install-file fallback injection is removed; an empty selection now runs `unit` as the smoke fallback. The critical-path branch replaces `runAllSuites` (which ran every suite including `install`/`slow`) with `PR_FULL_SUITES` (`unit`, `integration`, `security`). `suiteOf` is exported from `run-tests.cjs` (guarded by `require.main`) so the affected-tests lib can reuse the canonical suite-detection logic without duplication.
