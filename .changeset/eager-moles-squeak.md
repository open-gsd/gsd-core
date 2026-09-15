---
type: Fixed
pr: 4715
---
**TDD mode no longer trips on every task in Go, Ruby, Elixir and Python projects** — the RED-commit gate looked only for `*.test.*`, `*.spec.*` and `tests/`, so a commit adding `foo_test.go` was invisible and every behaviour-adding task halted with `TDD GATE TRIPPED: missing RED commit`. It now recognises the conventions the TDD reference already advertises, and matches at the repo root as well as in subdirectories. Rust stays a documented gap: `#[test]` lives in the implementation file, so no path-based gate can see it. (#4379)
