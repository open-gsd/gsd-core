---
type: Fixed
pr: 6404
---
**The executor's TDD gate-commit lookups accept a breaking-change `!` subject** — a `feat(01-03)!:` or `test(01-03)!:` plan commit counts in the TDD review checkpoint, but the RED, GREEN and REFACTOR lookups in the TDD reference anchored on `):` and missed it, so the executor wrote a false violation under `## TDD Gate Compliance`. The three lookups now accept the optional `!`. (#6120)
