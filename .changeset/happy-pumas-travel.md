---
type: Fixed
pr: 5461
---
**The TDD RED-commit gate now recognizes nested test paths** — `TDD GATE TRIPPED: missing RED commit` halted a Cargo task; matching now ignores case, a `test/` directory counts, and `*.test.*` and `test_*.py` no longer match across `/`, so a path such as `src/a.test.d/impl.js` or `test_utils/foo.py` no longer satisfies the gate (#5181).
