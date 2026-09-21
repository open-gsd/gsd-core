---
type: Fixed
pr: 4701
---
**TDD RED evidence now routes by the resolved actual test runner** — the Node TAP classifier runs only for actual Node built-in compatible TAP evidence, a rerun forced by an incompatible reporter is resubmitted to that same classifier instead of falling through to self-attestation, other identified runners receive direct inspection of their planned target assertion, and unresolved runners halt before GREEN. The references now also name the direct-inspection branch's known limits: it has no deterministic backstop, and a non-Node runner whose output happened to be Node-compatible TAP no longer receives an accidental machine-checked verdict.
