---
type: Fixed
pr: 0
---
**A vitest test file that crashed at load can no longer pass as RED evidence** — `check tdd-red-evidence` returned RED_EVIDENCE_OK when the target was the crashing file's own name; it now returns INVALID_RED (`fixture_or_load_failure`). (#5721)
