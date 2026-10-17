---
type: Fixed
pr: 5461
---
**The TDD RED-commit gate now recognises nested test paths** — `crates/core/tests/…`, `src/__tests__/…` and `pkg/api/test_x.py` count as test files at any depth, not only at the repo root (#5181).
