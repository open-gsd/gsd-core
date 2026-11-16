---
type: Changed
pr: 5454
---
**`gsd-tools query commit` with only `--files-removed` now resolves the phase from those paths** — a removal under a phase directory honors that phase's `phase_commit_docs` override. It prints `skipped` and commits nothing when the override is false. It also resolves the phase for `branching_strategy: phase`, where before it ignored both. A committed result now carries a `resolved_branch` field, present only when a branch resolved (#5506).
