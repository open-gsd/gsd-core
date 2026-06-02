---
type: Added
pr: 595
---
**Per-phase granularity overrides (`granularities.<phaseType>`)** — planning granularity can now be set per phase type (planning/discuss/research/execution/verification/completion) to override the global `granularity`, mirroring `models.<phaseType>`. Resolve with `gsd-tools query resolve-granularity <phaseType>`.
