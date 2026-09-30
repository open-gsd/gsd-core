---
type: Fixed
pr: 4701
---
**TDD RED evidence now uses format adapters** — Node and Vitest TAP share a standards-based parser, while Maven Surefire/Failsafe retain JUnit XML support through an XML parser. swift-testing console and Python `unittest` text reports get their own adapters. All four normalize individual test results for the same target-failure gate. Incomplete reports (including swift-testing or `unittest` summaries that count tests or failures without naming them, and `unittest` load failures), TAP bailouts, skipped/TODO targets, and ambiguous identities block GREEN; Vitest no longer relies on self-attestation. Parsers ship with installed runtimes without requiring node_modules.
