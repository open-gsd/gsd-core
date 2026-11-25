---
type: Changed
pr: 5454
---
**`gsd-tools query commit` with only `--files-removed` now resolves the phase from those paths** — a removal under a phase directory honors that phase's `phase_commit_docs` override. It prints `skipped` and commits nothing when the override is false (#5506).
