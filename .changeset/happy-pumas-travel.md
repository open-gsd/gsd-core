---
type: Fixed
pr: 5461
---
**The TDD RED-commit gate now recognizes nested test paths** — a Cargo workspace task halted with `TDD GATE TRIPPED: missing RED commit` on a nested test file. The gate matched `tests/` only at the repo root, and every pattern now matches at any depth (#5181).
