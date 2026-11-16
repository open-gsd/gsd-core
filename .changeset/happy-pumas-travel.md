---
type: Fixed
pr: 5461
---
**The TDD RED-commit gate now recognizes nested test paths** — a Cargo workspace task halted with `TDD GATE TRIPPED: missing RED commit` because the gate matched `tests/` only at the repo root (#5181). The gate now also ignores case, counts `test/` directories and no longer matches `*.test.*` or `test_*.py` across `/`, so a RED commit touching only `src/a.test.d/impl.js` or `test_utils/foo.py` now trips it.
