---
type: Fixed
pr: 5461
---
**The TDD RED-commit gate now recognizes nested test paths** — a Cargo workspace task halted with `TDD GATE TRIPPED: missing RED commit`, and the gate now also ignores case, counts `test/` and keeps `*.test.*` and `test_*.py` inside one path segment (#5181).
