---
type: Fixed
pr: 4701
---
**TDD RED evidence now uses format adapters** — Node and Vitest TAP share a standards-based parser, while Maven Surefire/Failsafe retain JUnit XML support through an XML parser. Both normalize individual test results for the same target-failure gate. Incomplete reports, TAP bailouts, skipped/TODO targets, and ambiguous identities block GREEN; Vitest no longer relies on self-attestation. Parsers ship with installed runtimes without requiring node_modules.
