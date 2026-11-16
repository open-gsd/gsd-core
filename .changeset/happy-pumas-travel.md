---
type: Fixed
pr: 5461
---
**The TDD RED-commit gate now recognizes nested test paths** — `TDD GATE TRIPPED: missing RED commit` halted a Cargo task; the gate now ignores case, counts `test/`, keeps `*.test.*` and `test_*.py` in one segment (#5181).
