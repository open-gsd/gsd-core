---
type: Fixed
pr: 5461
---
**The TDD RED-commit gate now recognizes nested test paths** — a Cargo workspace task halted with `TDD GATE TRIPPED: missing RED commit` after a valid test commit. The gate matched `tests/`, `__tests__/` and `test_*.py` only at the repo root. Those patterns now match at any depth, so `crates/core/tests/…`, `src/__tests__/…` and `pkg/api/test_x.py` count as test files. The gate also matches case-insensitively and accepts a `test/` directory, as the behavior-adding check already did. `test_*.py` now matches the file name only, so `test_utils/` no longer makes every `.py` file under it a test file (#5181).
