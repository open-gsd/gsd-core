---
type: Fixed
pr: 4701
---
**TDD RED evidence now routes by the resolved actual test runner** — the Node TAP classifier runs only for actual Node built-in compatible TAP evidence, other identified runners receive direct inspection of their planned target assertion, and unresolved runners halt before GREEN.
