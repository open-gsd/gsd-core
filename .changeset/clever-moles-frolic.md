---
type: Fixed
pr: 2467
---
**`/gsd-ship` no longer emits a 100%-missing TDD Audit noise table** — the TDD Audit PR-body section was always emitted, but the execute pipeline only writes `gate_status:` git trailers when TDD mode is active. Without TDD mode (the default), every commit was counted `missing` and the table was pure noise with no way to disable it. The section is now gated behind `workflow.tdd_mode`: when TDD mode is off, both the TDD Audit section and the aggregate `gate_status:` trailer are skipped entirely; when on, the existing behavior is preserved.
