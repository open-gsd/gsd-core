---
type: Fixed
pr: 4701
---
**TDD mode accepts a genuine Vitest RED instead of rejecting it as `zero_tests_discovered`** — `check tdd-red-evidence` now reads each report format through an adapter: TAP for Node and Vitest (`tap`/`tap-flat`), JUnit XML for Maven Surefire/Failsafe, swift-testing console output (including swift-testing 6.1 and tests without a display name), and Python `unittest` text. All four feed the same target-failure gate. The gate is stricter than before: a TAP report needs its plan, an XML report must be one complete document with no console text around it, the record's exit code must be a non-negative integer, and incomplete reports, bailouts, `unittest` load failures, skipped/TODO targets and ambiguous names block GREEN. The parsers ship with installed runtimes, which need no `node_modules`.
