---
type: Fixed
pr: 5917
---
**A test file that crashed at load can no longer pass as RED evidence** — `check tdd-red-evidence` returned RED_EVIDENCE_OK when the target was the crashing file's own entry (a vitest `bad.test.js`, a jest-junit `Test suite failed to run`, or a node:test file-level failure); it now returns INVALID_RED (`fixture_or_load_failure`). (#5721)
