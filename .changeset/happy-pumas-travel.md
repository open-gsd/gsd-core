---
type: Fixed
pr: 5461
---
**The TDD RED-commit gate now recognizes nested test paths** — a Cargo workspace task halted with `TDD GATE TRIPPED: missing RED commit` because the gate matched `tests/` only at the repo root (#5181).
