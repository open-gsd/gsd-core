---
type: Fixed
pr: 5461
---
**The TDD RED-commit gate now recognizes nested test paths** — a behavior-adding task in a Cargo workspace or monorepo halted with `TDD GATE TRIPPED: missing RED commit` even after its valid failing test was committed, because `tests/`, `__tests__/` and `test_*.py` matched only at the repo root. Those patterns now match at any depth: `crates/core/tests/…`, `src/__tests__/…` and `pkg/api/test_x.py` count as test files; `test_*.py` now matches the file name only, so a root-level directory such as `test_utils/` no longer makes every `.py` file under it a test file; a file there still counts when another convention matches it, such as `*_test.py` (#5181).
