---
type: Added
pr: 6310
---
**Explicit parent review for unsupported TDD RED reports** — `check tdd-red-evidence` now distinguishes `UNSUPPORTED_REPORT` from invalid RED, with null counters when parsing is unavailable. Unsupported output alone still blocks GREEN. An explicit parent decision bound to the complete original capture, unique run identity, and current file hashes can authorize `parent_reviewed_red` without fabricating `RED_EVIDENCE_OK`; children must escalate rather than self-waive. Malformed supported reports, known-invalid evidence, and stale decisions remain blocked. Consumers must handle the new verdict, nullable counters, and separate parent authorization.
